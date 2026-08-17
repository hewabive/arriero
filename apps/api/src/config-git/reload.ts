import { resetAllConfigStores } from "../config-store/registry.js";
import { environmentJobs } from "../envs/repository.js";
import { syncAutoCapacitiesInMemory } from "../resources/repository.js";

export function reloadPortableConfigCaches() {
  resetAllConfigStores();
  environmentJobs.clear();
  syncAutoCapacitiesInMemory();
}
