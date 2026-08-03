import { spawn } from "node:child_process";

export type CommandLog = { write(chunk: string | Buffer): unknown };

export type CommandResult = { exitCode: number; stdout: string };

export type RunCommandOptions = {
  log: CommandLog;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  collectStdout?: boolean;
};

export function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {}
}

export function runLoggedCommand(
  command: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const executable = command[0];
  if (!executable) {
    return Promise.reject(new Error("command must not be empty"));
  }
  return new Promise((resolveDone, reject) => {
    const child = spawn(executable, command.slice(1), {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    const chunks: Buffer[] = [];
    const onAbort = () => killProcessTree(child.pid);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.collectStdout) {
        chunks.push(chunk);
      }
      options.log.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => options.log.write(chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (signal) {
        options.log.write(`\n# terminated by ${signal}\n`);
      }
      resolveDone({
        exitCode: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}
