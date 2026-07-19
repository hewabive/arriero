import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class GitCommandError extends Error {
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

export function gitArguments(args: string[]): string[] {
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

export function redactGitOutput(value: string): string {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi,
    "$1***@",
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
