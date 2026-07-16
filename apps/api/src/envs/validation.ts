import type { EnvironmentSpec } from "@llama-manager/core";

import { environmentDirectory } from "./paths.js";
import { environmentProvisioner } from "./provisioners.js";

export function environmentLayoutError(spec: EnvironmentSpec): string | null {
  return environmentProvisioner(spec.engine).validateLayout(
    spec,
    environmentDirectory(spec),
  );
}
