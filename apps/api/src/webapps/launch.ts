import { createHash } from "node:crypto";

import { webappDescriptor, type WebappConfigRecord } from "@arriero/core";

import { renderWebappEnvironment } from "./render.js";
import { webappDataDir } from "./paths.js";

export type WebappLaunchSnapshot = {
  binaryPath: string;
  cliArgs: string[];
  cwd: string;
  envSpecId: string;
  renderHash: string;
};

function webappRenderHash(env: Record<string, string>): string {
  const canonical = Object.entries(env).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function buildWebappLaunchSnapshot(
  record: WebappConfigRecord,
  entrypoint: string,
): { snapshot: WebappLaunchSnapshot; env: Record<string, string> } {
  const descriptor = webappDescriptor(record.kind);
  const env = renderWebappEnvironment(record);
  return {
    snapshot: {
      binaryPath: entrypoint,
      cliArgs: [
        ...descriptor.launch.argvPrefix,
        descriptor.launch.hostFlag,
        record.http.host,
        descriptor.launch.portFlag,
        String(record.http.port),
      ],
      cwd: webappDataDir(record.name),
      envSpecId: record.envSpecId,
      renderHash: webappRenderHash(env),
    },
    env,
  };
}

export function serializeWebappLaunchSnapshot(
  snapshot: WebappLaunchSnapshot,
): string {
  return JSON.stringify(snapshot);
}

export function parseWebappLaunchSnapshot(
  raw: string | null | undefined,
): WebappLaunchSnapshot | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<WebappLaunchSnapshot>;
    if (
      typeof value.binaryPath !== "string" ||
      !Array.isArray(value.cliArgs) ||
      typeof value.cwd !== "string" ||
      typeof value.envSpecId !== "string" ||
      typeof value.renderHash !== "string"
    ) {
      return null;
    }
    return {
      binaryPath: value.binaryPath,
      cliArgs: value.cliArgs.map(String),
      cwd: value.cwd,
      envSpecId: value.envSpecId,
      renderHash: value.renderHash,
    };
  } catch {
    return null;
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function hasWebappLaunchDrift(
  record: WebappConfigRecord,
  entrypoint: string,
  snapshot: WebappLaunchSnapshot,
): boolean {
  const current = buildWebappLaunchSnapshot(record, entrypoint).snapshot;
  return (
    current.binaryPath !== snapshot.binaryPath ||
    current.cwd !== snapshot.cwd ||
    current.envSpecId !== snapshot.envSpecId ||
    current.renderHash !== snapshot.renderHash ||
    !sameStringArray(current.cliArgs, snapshot.cliArgs)
  );
}
