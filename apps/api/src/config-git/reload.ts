import { resetAllConfigStores } from "../config-store/registry.js";
import { environmentJobs } from "../envs/repository.js";
import { refreshAutoCapacities } from "../resources/repository.js";

export function reloadPortableConfigCaches() {
  resetAllConfigStores();
  environmentJobs.clear();
  refreshAutoCapacities();
}
