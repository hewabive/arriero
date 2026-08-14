import { resetAllConfigStores } from "../config-store/registry.js";
import { resetEnvironmentRepository } from "../envs/repository.js";
import { refreshAutoCapacities } from "../resources/repository.js";

export function reloadPortableConfigCaches() {
  resetAllConfigStores();
  resetEnvironmentRepository();
  refreshAutoCapacities();
}
