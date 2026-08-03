import type { PrerequisiteInstallCapability } from "@arriero/core";
import { spawn } from "node:child_process";

const SUDO_PROBE_TIMEOUT_MS = 4000;

export type SudoProbeResult = {
  code: number | null;
  stderr: string;
  spawnError: string | null;
};

function probePasswordlessSudo(
  timeoutMs = SUDO_PROBE_TIMEOUT_MS,
): Promise<SudoProbeResult> {
  return new Promise((resolveDone) => {
    const child = spawn("sudo", ["-n", "true"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: timeoutMs,
    });
    let stderr = "";
    let settled = false;
    const finish = (result: SudoProbeResult) => {
      if (!settled) {
        settled = true;
        resolveDone(result);
      }
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) =>
      finish({ code: null, stderr, spawnError: error.message }),
    );
    child.on("close", (code) =>
      finish({ code, stderr: stderr.trim(), spawnError: null }),
    );
  });
}

export async function detectInstallCapability(
  probe: () => Promise<SudoProbeResult> = probePasswordlessSudo,
  uid: number | undefined = process.getuid?.(),
): Promise<PrerequisiteInstallCapability> {
  if (process.platform !== "linux") {
    return {
      available: false,
      method: null,
      reason: "package installation from the UI is only supported on Linux",
    };
  }
  if (uid === 0) {
    return { available: true, method: "root", reason: null };
  }
  const result = await probe();
  if (result.spawnError) {
    return {
      available: false,
      method: null,
      reason: `sudo is not available: ${result.spawnError}`,
    };
  }
  if (result.code === 0) {
    return { available: true, method: "passwordless-sudo", reason: null };
  }
  return {
    available: false,
    method: null,
    reason: result.stderr || "sudo requires a password for the manager user",
  };
}
