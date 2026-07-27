import type { EnvironmentSpec } from "@arriero/core";
import { resolve, sep } from "node:path";

import { config } from "../config.js";
import { environmentProvisioner } from "./provisioners.js";

function slug(value: string) {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") ||
    "env"
  );
}

export function environmentDirectory(
  spec: Pick<EnvironmentSpec, "id" | "engine" | "version">,
) {
  const suffix = spec.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return resolve(
    config.envsDir,
    `${slug(spec.engine)}-${slug(spec.version)}-${suffix}`,
  );
}

export function environmentStagingDirectory(
  spec: Pick<EnvironmentSpec, "id" | "engine" | "version">,
) {
  return `${environmentDirectory(spec)}.staging`;
}

export function environmentEntrypoint(
  spec: Pick<EnvironmentSpec, "id" | "engine" | "version">,
) {
  return resolve(
    environmentDirectory(spec),
    environmentProvisioner(spec.engine).entrypointRelative,
  );
}

export function assertEnvironmentPath(path: string) {
  const root = resolve(config.envsDir);
  const resolved = resolve(path);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`environment path escapes ${root}`);
  }
  return resolved;
}
