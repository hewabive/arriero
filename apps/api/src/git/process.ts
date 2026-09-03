import {
  execFileSync,
  spawn,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { traceBlockingSection } from "../system/event-loop.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_SSH_COMMAND:
      process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oConnectTimeout=10",
    LC_ALL: "C",
  };
}

function gitArguments(args: string[]): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "submodule.recurse=false",
    ...args,
  ];
}

export function assertGitRemoteUrl(
  value: string,
  options: { allowFile?: boolean; allowHttp?: boolean } = {},
): void {
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)) return;
  const protocolLabel = options.allowHttp
    ? "SSH, HTTPS or HTTP"
    : "SSH or HTTPS";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `origin must be an ${protocolLabel} repository URL${options.allowFile ? " (file: is also allowed)" : ""}`,
    );
  }
  const protocols = new Set([
    "https:",
    "ssh:",
    ...(options.allowHttp ? ["http:"] : []),
    ...(options.allowFile ? ["file:"] : []),
  ]);
  if (!protocols.has(url.protocol)) {
    throw new Error(
      `origin must use ${protocolLabel}${options.allowFile ? " (or file:)" : ""}`,
    );
  }
  if (
    url.password ||
    ((url.protocol === "https:" || url.protocol === "http:") && url.username)
  ) {
    throw new Error("origin URL must not contain credentials");
  }
}

export function redactGitOutput(value: string): string {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]*))?@/gi,
    (match, scheme: string, user: string, password?: string) => {
      if (scheme.toLowerCase() !== "ssh://") return `${scheme}***@`;
      return password === undefined ? match : `${scheme}${user}:***@`;
    },
  );
}

export function gitOutput(result: GitResult): string {
  return redactGitOutput(
    [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
  );
}

export function runGit(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    allowExitCodes?: number[];
    signal?: AbortSignal;
    onOutput?: (target: "stdout" | "stderr", chunk: string) => void;
    killProcessGroup?: boolean;
  } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const allowed = new Set(options.allowExitCodes ?? [0]);

  return new Promise((resolveDone, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("git command canceled"));
      return;
    }
    const useProcessGroup =
      options.killProcessGroup === true && process.platform !== "win32";
    const child = spawn("git", gitArguments(args), {
      cwd,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const signalChild = (signal: NodeJS.Signals) => {
      try {
        if (useProcessGroup && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        child.kill(signal);
      }
    };

    const terminate = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      signalChild("SIGTERM");
      forceKillTimer = setTimeout(() => signalChild("SIGKILL"), 2_000);
      forceKillTimer.unref?.();
    };

    const abort = () => terminate(new Error("git command canceled"));

    const finish = (error?: Error, result?: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveDone(result!);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate(
          new Error(
            `git output exceeded ${Math.floor(maxOutputBytes / 1024)} KiB`,
          ),
        );
        return;
      }
      const text = chunk.toString();
      if (target === "stdout") stdout += text;
      else stderr += text;
      try {
        options.onOutput?.(target, text);
      } catch (error) {
        terminate(error as Error);
      }
    };

    const timer = setTimeout(() => {
      terminate(new Error(`git command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      const result = { stdout, stderr, exitCode: code ?? 1 };
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (signal) {
        finish(new GitCommandError(`git terminated by ${signal}`, result));
        return;
      }
      if (!allowed.has(result.exitCode)) {
        finish(
          new GitCommandError(
            gitOutput(result) || `git exited with code ${result.exitCode}`,
            result,
          ),
        );
        return;
      }
      finish(undefined, result);
    });
  });
}

export async function tryGit(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const result = await runGit(cwd, args);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getGitAuthorIdentity(cwd: string): Promise<{
  authorName: string | null;
  authorEmail: string | null;
}> {
  const [authorName, authorEmail] = await Promise.all([
    tryGit(cwd, ["config", "--get", "user.name"]),
    tryGit(cwd, ["config", "--get", "user.email"]),
  ]);
  return { authorName, authorEmail };
}

function syncErrorText(error: unknown): GitResult {
  const value = error as {
    status?: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    message?: string;
  };
  const toText = (part: string | Buffer | undefined) =>
    typeof part === "string" ? part : (part?.toString() ?? "");
  return {
    stdout: toText(value.stdout),
    stderr: toText(value.stderr),
    exitCode: value.status ?? 1,
  };
}

export function runGitSync(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
): string {
  const execOptions: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
  try {
    return traceBlockingSection(`git:${args[0] ?? "unknown"}`, () =>
      execFileSync("git", gitArguments(args), execOptions).trim(),
    );
  } catch (error) {
    const result = syncErrorText(error);
    throw new GitCommandError(
      gitOutput(result) ||
        redactGitOutput((error as Error).message) ||
        "git command failed",
      result,
    );
  }
}

export function tryGitSync(cwd: string, args: string[]): string | null {
  try {
    return runGitSync(cwd, args) || null;
  } catch {
    return null;
  }
}

export async function isExactGitRepository(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const result = await runGit(path, ["rev-parse", "--show-toplevel"]);
    return realpathSync(result.stdout.trim()) === realpathSync(resolve(path));
  } catch {
    return false;
  }
}

export function isExactGitRepositorySync(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return (
      realpathSync(runGitSync(path, ["rev-parse", "--show-toplevel"])) ===
      realpathSync(resolve(path))
    );
  } catch {
    return false;
  }
}

export async function repositoryHeadCommit(
  repoPath: string,
): Promise<string | null> {
  if (!(await isExactGitRepository(repoPath))) {
    return null;
  }
  return tryGit(repoPath, ["rev-parse", "HEAD"]);
}

export function repositoryHeadCommitSync(repoPath: string): string | null {
  if (!isExactGitRepositorySync(repoPath)) {
    return null;
  }
  return tryGitSync(repoPath, ["rev-parse", "HEAD"]);
}
