import {
  instanceHttpAddress,
  isWildcardHost,
  type Instance,
  type InstanceHealthSummary,
} from "@arriero/core";

export function browserReachableHost(host: string, nodeHost: string | null) {
  if (isWildcardHost(host)) {
    return nodeHost && !isWildcardHost(nodeHost) ? nodeHost : null;
  }
  return host;
}

export function urlHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function llamaServerWebUrl(instance: Instance, nodeHost: string | null) {
  const address = instanceHttpAddress(instance);
  if (!address) {
    return null;
  }
  const host = browserReachableHost(address.host, nodeHost);
  return host
    ? `http://${urlHost(host)}:${address.port}${address.prefix}`
    : null;
}

export function canOpenLlamaWebUi(
  health: InstanceHealthSummary | undefined,
  url: string | null,
) {
  if (!health || !url) {
    return false;
  }
  return ["starting", "loading", "ready", "degraded", "stale"].includes(
    health.status,
  );
}

export function llamaWebUiTooltip(
  health: InstanceHealthSummary | undefined,
  url: string | null,
) {
  if (!url) {
    return "HTTP URL is unavailable for this instance";
  }
  if (!health) {
    return "Health summary is loading";
  }
  if (canOpenLlamaWebUi(health, url)) {
    return `Open ${url}`;
  }
  if (health.status === "stopped") {
    return "Start the instance before opening Web UI";
  }
  return health.reason;
}

export function openUrlInNewTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}
