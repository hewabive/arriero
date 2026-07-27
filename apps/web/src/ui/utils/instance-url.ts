import type { Instance, InstanceHealthSummary } from "@arriero/core";

function argString(args: Instance["args"], key: string) {
  const value = args[key];
  if (value === undefined || value === null || Array.isArray(value)) {
    return "";
  }
  return String(value);
}

function apiPrefixFromArgs(args: Instance["args"]) {
  const raw = argString(args, "--api-prefix").trim();
  if (!raw) {
    return "";
  }
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return normalized.replace(/\/$/, "");
}

function browserReachableHost(host: string) {
  if (host === "0.0.0.0" || host === "::") {
    const pageHost =
      typeof window === "undefined" ? "" : window.location.hostname;
    return pageHost && pageHost !== "0.0.0.0" && pageHost !== "::"
      ? pageHost
      : "127.0.0.1";
  }
  return host;
}

function managerReachableHost(host: string) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function urlHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function instancePort(instance: Instance) {
  const port = Number(instance.args["--port"] ?? 8080);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function llamaServerWebUrl(instance: Instance) {
  const rawHost = argString(instance.args, "--host") || "127.0.0.1";
  if (rawHost.endsWith(".sock")) {
    return null;
  }

  const port = instancePort(instance) ?? 8080;
  return `http://${urlHost(browserReachableHost(rawHost))}:${port}${apiPrefixFromArgs(instance.args)}`;
}

export function llamaServerApiUrl(instance: Instance) {
  const rawHost = argString(instance.args, "--host") || "127.0.0.1";
  if (rawHost.endsWith(".sock")) {
    return null;
  }

  const port = instancePort(instance) ?? 8080;
  return `http://${urlHost(managerReachableHost(rawHost))}:${port}${apiPrefixFromArgs(instance.args)}`;
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
