import {
  webappDescriptor,
  type WebappConfigRecord,
  type WebappDriftField,
} from "@arriero/core";

import { sameStringArray } from "../process/launch-snapshot.js";
import { canonicalJsonDigest } from "../utils/canonical-json.js";
import { renderWebappEnvironment } from "./render.js";
import { webappDataDir } from "./paths.js";

export type WebappLaunchSnapshot = {
  binaryPath: string;
  cliArgs: string[];
  cwd: string;
  envSpecId: string;
  renderHash: string;
};

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
      renderHash: canonicalJsonDigest(env),
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

export function webappLaunchDriftFields(
  record: WebappConfigRecord,
  entrypoint: string,
  snapshot: WebappLaunchSnapshot,
): WebappDriftField[] {
  const current = buildWebappLaunchSnapshot(record, entrypoint).snapshot;
  const fields: WebappDriftField[] = [];
  if (
    current.envSpecId !== snapshot.envSpecId ||
    current.binaryPath !== snapshot.binaryPath
  ) {
    fields.push("environment");
  }
  if (!sameStringArray(current.cliArgs, snapshot.cliArgs)) {
    fields.push("arguments");
  }
  if (current.cwd !== snapshot.cwd) {
    fields.push("data-dir");
  }
  if (current.renderHash !== snapshot.renderHash) {
    fields.push("rendered-env");
  }
  return fields;
}
