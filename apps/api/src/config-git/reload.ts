import { resetEnvironmentRepository } from "../envs/repository.js";
import { resetInstancesCache } from "../instances/config-files.js";
import { resetNodesCache } from "../nodes/repository.js";
import { resetPathCatalogCache } from "../path-catalog/repository.js";
import { resetConfigFilesCache } from "../proxy/config-files.js";
import {
  refreshAutoCapacities,
  resetResourcePoolsCache,
} from "../resources/repository.js";

export function reloadPortableConfigCaches() {
  resetInstancesCache();
  resetConfigFilesCache();
  resetResourcePoolsCache();
  refreshAutoCapacities();
  resetNodesCache();
  resetPathCatalogCache();
  resetEnvironmentRepository();
}
