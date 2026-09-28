import type { SystemVirtualization } from "@arriero/core";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { logger } from "../logger.js";

let cached: SystemVirtualization | null | undefined;

export function virtualizationFromProbe(input: {
  status: number | null;
  stdout: string;
  readCpuinfo: () => string;
}): SystemVirtualization | null {
  const type = input.stdout.trim();
  if (input.status === 0 && type && type !== "none") {
    return { type };
  }
  return /(?:^|\s)hypervisor(?:\s|$)/m.test(input.readCpuinfo())
    ? { type: "unknown" }
    : null;
}

function readCpuinfo(): string {
  try {
    return readFileSync("/proc/cpuinfo", "utf8");
  } catch (error) {
    logger.debug({ error }, "cpuinfo is unreadable; hypervisor flag unknown");
    return "";
  }
}

export function detectVirtualization(): SystemVirtualization | null {
  if (cached !== undefined) {
    return cached;
  }
  const probe = spawnSync("systemd-detect-virt", ["--vm"], {
    encoding: "utf8",
    timeout: 1_000,
  });
  cached = virtualizationFromProbe({
    status: probe.status,
    stdout: probe.stdout ?? "",
    readCpuinfo,
  });
  return cached;
}
