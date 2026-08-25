import type { EnvironmentSpec } from "@arriero/core";
import { resolve } from "node:path";

import { config } from "../config.js";
import { assertPathWithinRoot } from "../utils/path-guard.js";
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

export const ENVIRONMENT_STAGING_SUFFIX = ".staging";

export function environmentStagingDirectory(
  spec: Pick<EnvironmentSpec, "id" | "engine" | "version">,
) {
  return `${environmentDirectory(spec)}${ENVIRONMENT_STAGING_SUFFIX}`;
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
  return assertPathWithinRoot(config.envsDir, path, "environment");
}
