import { engineDescriptor } from "./engine-descriptor.js";
import type { Instance, InstanceArgValue } from "./instance.js";

export type InstanceHttpSource = {
  kind?: Instance["kind"] | undefined;
  args: Instance["args"];
};

export type InstanceHttpAddress = {
  host: string;
  port: number;
  prefix: string;
};

function firstArgValue(
  args: Instance["args"],
  keys: readonly string[],
): InstanceArgValue | undefined {
  for (const key of keys) {
    if (args[key] !== undefined) {
      return args[key];
    }
  }
  return undefined;
}

function argText(
  value: InstanceArgValue | undefined,
  fallback: string,
): string {
  if (value === undefined || value === null || Array.isArray(value)) {
    return fallback;
  }
  return String(value);
}

function argPort(
  value: InstanceArgValue | undefined,
  defaultPort: number,
): number {
  const parsed = Number(argText(value, String(defaultPort)));
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : defaultPort;
}

function normalizedPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/$/, "");
}

export function instanceHttpAddress(
  instance: InstanceHttpSource,
): InstanceHttpAddress | null {
  const http = engineDescriptor(instance.kind ?? "llama-server").http;
  const host = argText(
    firstArgValue(instance.args, http.hostArgKeys),
    http.defaultHost,
  );
  if (host.endsWith(".sock")) {
    return null;
  }
  return {
    host,
    port: argPort(
      firstArgValue(instance.args, http.portArgKeys),
      http.defaultPort,
    ),
    prefix: normalizedPrefix(
      argText(firstArgValue(instance.args, http.apiPrefixArgKeys), ""),
    ),
  };
}
