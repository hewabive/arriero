import {
  instanceHttpAddress,
  isWildcardHost,
  type Instance,
  type InstanceHealthSummary,
} from "@arriero/core";

export function browserReachableHost(host: string) {
  if (isWildcardHost(host)) {
    const pageHost =
      typeof window === "undefined" ? "" : window.location.hostname;
    return pageHost && !isWildcardHost(pageHost) ? pageHost : "127.0.0.1";
  }
  return host;
}

export function urlHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function llamaServerWebUrl(instance: Instance) {
  const address = instanceHttpAddress(instance);
  if (!address) {
    return null;
  }
  return `http://${urlHost(browserReachableHost(address.host))}:${address.port}${address.prefix}`;
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
