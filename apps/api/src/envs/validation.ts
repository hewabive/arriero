import type { EnvironmentSpec } from "@arriero/core";

import { environmentDirectory } from "./paths.js";
import { environmentProvisioner } from "./provisioners.js";

export function environmentLayoutError(spec: EnvironmentSpec): string | null {
  return environmentProvisioner(spec.engine).validateLayout(
    spec,
    environmentDirectory(spec),
  );
}
