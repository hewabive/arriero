import type { SystemVirtualization } from "@arriero/core";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let cached: SystemVirtualization | null | undefined;

export function virtualizationFromProbe(input: {
  status: number | null;
  stdout: string;
  cpuinfo: string;
}): SystemVirtualization | null {
  const type = input.stdout.trim();
  if (input.status === 0 && type && type !== "none") {
    return { type };
  }
  return /(?:^|\s)hypervisor(?:\s|$)/m.test(input.cpuinfo)
    ? { type: "unknown" }
    : null;
}

export function detectVirtualization(): SystemVirtualization | null {
  if (cached !== undefined) {
    return cached;
  }
  const probe = spawnSync("systemd-detect-virt", ["--vm"], {
    encoding: "utf8",
    timeout: 1_000,
  });
  let cpuinfo = "";
  try {
    cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
  } catch {}
  cached = virtualizationFromProbe({
    status: probe.status,
    stdout: probe.stdout ?? "",
    cpuinfo,
  });
  return cached;
}
