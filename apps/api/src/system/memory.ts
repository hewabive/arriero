import type { SystemMemory } from "@arriero/core";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

import { clampRatio } from "./clamp.js";

function toMemory(input: {
  totalBytes: number;
  availableBytes: number;
  source: SystemMemory["source"];
}): SystemMemory {
  const totalBytes = Math.max(0, Math.floor(input.totalBytes));
  const availableBytes = Math.min(
    totalBytes,
    Math.max(0, Math.floor(input.availableBytes)),
  );
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedRatio: totalBytes === 0 ? 0 : clampRatio(usedBytes / totalBytes),
    source: input.source,
  };
}

export function parseLinuxMeminfo(contents: string): SystemMemory | null {
  const values = new Map<string, number>();
  for (const line of contents.split("\n")) {
    const match = /^([^:]+):\s+(\d+)\s+kB$/i.exec(line.trim());
    if (match) {
      values.set(match[1]!, Number(match[2]) * 1024);
    }
  }

  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  if (totalBytes === undefined || availableBytes === undefined) {
    return null;
  }

  return toMemory({
    totalBytes,
    availableBytes,
    source: "proc-meminfo",
  });
}

function readLinuxMemory(): SystemMemory | null {
  try {
    return parseLinuxMeminfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

function readNodeMemory(): SystemMemory {
  return toMemory({
    totalBytes: totalmem(),
    availableBytes: freemem(),
    source: "node-os",
  });
}

export function readSystemMemory(): SystemMemory {
  return readLinuxMemory() ?? readNodeMemory();
}
