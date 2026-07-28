import {
  execFileSync,
  spawn,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";

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
  options: { allowFile?: boolean } = {},
): void {
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `origin must be an SSH or HTTPS repository URL${options.allowFile ? " (file: is also allowed)" : ""}`,
    );
  }
  const protocols = new Set([
    "https:",
    "ssh:",
    ...(options.allowFile ? ["file:"] : []),
  ]);
  if (!protocols.has(url.protocol)) {
    throw new Error(
      `origin must use SSH or HTTPS${options.allowFile ? " (or file:)" : ""}`,
    );
  }
  if (url.password || (url.protocol === "https:" && url.username)) {
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
  } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const allowed = new Set(options.allowExitCodes ?? [0]);

  return new Promise((resolveDone, reject) => {
    const child = spawn("git", gitArguments(args), {
      cwd,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error, result?: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveDone(result!);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(
          new Error(
            `git output exceeded ${Math.floor(maxOutputBytes / 1024)} KiB`,
          ),
        );
        return;
      }
      if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`git command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      const result = { stdout, stderr, exitCode: code ?? 1 };
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
    return execFileSync("git", gitArguments(args), execOptions).trim();
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
