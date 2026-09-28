import type { ConfigReloadResult, ConfigState } from "@arriero/core";

import { request } from "./http.js";

export function getConfigState() {
  return request<{ data: ConfigState }>("/api/config/state");
}

export function reloadConfigFromDisk() {
  return request<{ data: ConfigReloadResult }>("/api/config/reload", {
    method: "POST",
  });
}
