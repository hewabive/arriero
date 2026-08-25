import { resetAllConfigStores } from "../config-store/registry.js";
import { environmentJobs } from "../envs/repository.js";

export function reloadPortableConfigCaches() {
  resetAllConfigStores();
  environmentJobs.clear();
}
