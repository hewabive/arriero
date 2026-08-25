import { findExecutableInPath, readVersionSync } from "../system/tool-probe.js";

export type NodeSourceTools = { git: string; npm: string; node: string };

export type NodeSourceToolsProbe =
  | { tools: NodeSourceTools; error: null }
  | { tools: null; error: string };

export function probeNodeSourceTools(
  pathValue = process.env.PATH,
): NodeSourceToolsProbe {
  const tools: Partial<NodeSourceTools> = {};
  for (const name of ["git", "npm"] as const) {
    const path = findExecutableInPath(name, pathValue);
    if (!path) {
      return { tools: null, error: `${name} was not found on PATH` };
    }
    if (!readVersionSync(path, name)) {
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
