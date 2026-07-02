let draining = false;

export function beginApiProxyDrain(): void {
  draining = true;
}

export function isApiProxyDraining(): boolean {
  return draining;
}

export function resetApiProxyDrain(): void {
  draining = false;
}

export function apiProxyDrainBody(protocol: "openai" | "anthropic"): unknown {
  const message =
    "llama-manager is restarting to apply an update; retry in a few seconds.";
  if (protocol === "anthropic") {
    return {
      type: "error",
      error: { type: "overloaded_error", message },
    };
  }
  return {
    error: {
      message,
      type: "server_error",
      code: "llama_manager_restarting",
      param: null,
    },
  };
}
