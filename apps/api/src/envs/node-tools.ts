import { execFileSync } from "node:child_process";

import { traceBlockingSection } from "../system/event-loop.js";
import { findExecutableInPath } from "../system/tool-probe.js";

export type NodeSourceTools = { git: string; npm: string; node: string };

export type NodeSourceToolsProbe =
  | { tools: NodeSourceTools; error: null }
  | { tools: null; error: string };

function readToolVersion(path: string, label: string): string | null {
  try {
    return traceBlockingSection(
      `${label}:version`,
      () =>
        execFileSync(path, ["--version"], {
          encoding: "utf8",
          timeout: 5_000,
        }).trim() || null,
    );
  } catch {
    return null;
  }
}

export function probeNodeSourceTools(
  pathValue = process.env.PATH,
): NodeSourceToolsProbe {
  const tools: Partial<NodeSourceTools> = {};
  for (const name of ["git", "npm"] as const) {
    const path = findExecutableInPath(name, pathValue);
    if (!path) {
      return { tools: null, error: `${name} was not found on PATH` };
    }
    if (!readToolVersion(path, name)) {
      return {
        tools: null,
        error: `could not read ${name} version from ${path}`,
      };
    }
    tools[name] = path;
  }
  return {
    tools: { git: tools.git!, npm: tools.npm!, node: process.execPath },
    error: null,
  };
}
