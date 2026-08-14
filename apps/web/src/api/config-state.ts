import type { ConfigReloadResult, ConfigState } from "@arriero/core";

import { nodeRequest } from "./http.js";

export function getConfigState() {
  return nodeRequest<{ data: ConfigState }>("/api/config/state");
}

export function reloadConfigFromDisk() {
  return nodeRequest<{ data: ConfigReloadResult }>("/api/config/reload", {
    method: "POST",
  });
}
