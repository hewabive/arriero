import { readFileSync } from "node:fs";

export function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function parsePidText(pid: string | null): number | null {
  const parsed = pid ? Number(pid) : null;
  return parsed && Number.isFinite(parsed) ? parsed : null;
}

export function processCommandMatchesBinary(pid: number, binaryPath: string) {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    return argv.includes(binaryPath);
  } catch {
    return false;
  }
}
