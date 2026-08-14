import type { ConfigState } from "@arriero/core";

import { nodeRequest } from "./http.js";

export function getConfigState() {
  return nodeRequest<{ data: ConfigState }>("/api/config/state");
}
