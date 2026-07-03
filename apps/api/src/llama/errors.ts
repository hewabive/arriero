import type { EndpointProbe } from "@llama-manager/core";

export function llamaEndpointErrorMessage(probe: EndpointProbe): string {
  const body = probe.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }
  return (
    probe.error ?? `llama-server returned ${probe.status ?? "no response"}`
  );
}
