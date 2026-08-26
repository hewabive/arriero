import type { ApiProxyProtocolAdapter } from "./protocol.js";

let draining = false;

export function beginApiProxyDrain(): void {
  draining = true;
}

export function isApiProxyDraining(): boolean {
  return draining;
}

export function apiProxyDrainBody(adapter: ApiProxyProtocolAdapter): unknown {
  return adapter.unavailableError(
    "arriero is restarting to apply an update; retry in a few seconds.",
  );
}
