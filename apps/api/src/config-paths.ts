import { sep } from "node:path";

import { config } from "./config.js";

type PortableRoot = { token: string; dir: string };

const ROOT_READERS: readonly (readonly [string, () => string])[] = [
  ["ARRIERO_HOME", () => config.rootDir],
  ["ARRIERO_DATA_DIR", () => config.dataDir],
  ["ARRIERO_CONFIG_DIR", () => config.configDir],
  ["ARRIERO_RUNTIME_DIR", () => config.runtimeDir],
  ["ARRIERO_LOGS_DIR", () => config.logsDir],
  ["ARRIERO_BUILDS_DIR", () => config.buildsDir],
  ["ARRIERO_SOURCES_DIR", () => config.sourcesDir],
  ["ARRIERO_ENVS_DIR", () => config.envsDir],
  ["ARRIERO_MODELS_DIR", () => config.modelsDir],
  ["ARRIERO_SLOTS_DIR", () => config.slotsDir],
];

function portableRoots(): PortableRoot[] {
  return ROOT_READERS.map(([token, read]) => ({ token, dir: read() })).filter(
    (root) => root.dir.length > 1 && root.dir.startsWith(sep),
  );
}

function placeholder(token: string): string {
  return `\${${token}}`;
}

function containingRoot(value: string): PortableRoot | null {
  let best: PortableRoot | null = null;
  for (const root of portableRoots()) {
    if (value !== root.dir && !value.startsWith(`${root.dir}${sep}`)) {
      continue;
    }
    if (!best || root.dir.length < best.dir.length) {
      best = root;
    }
  }
  return best;
}

export function toPortablePath(value: string): string {
  if (!value.startsWith(sep)) {
    return value;
  }
  const root = containingRoot(value);
  return root
    ? `${placeholder(root.token)}${value.slice(root.dir.length)}`
    : value;
}

export function fromPortablePath(value: string): string {
  if (!value.includes("${")) {
    return value;
  }
  let expanded = value;
  for (const root of portableRoots()) {
    expanded = expanded.split(placeholder(root.token)).join(root.dir);
  }
  return expanded;
}

function mapStrings(value: unknown, map: (value: string) => string): unknown {
  if (typeof value === "string") {
    return map(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, map));
  }
  if (value && typeof value === "object") {
    const mapped: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      mapped[key] = mapStrings(item, map);
    }
    return mapped;
  }
  return value;
}

export function toPortableConfig<T>(value: T): T {
  return mapStrings(value, toPortablePath) as T;
}

export function fromPortableConfig<T>(value: T): T {
  return mapStrings(value, fromPortablePath) as T;
}

export function hasPortablePathCandidate(value: unknown): boolean {
  if (typeof value === "string") {
    return toPortablePath(value) !== value;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasPortablePathCandidate(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => hasPortablePathCandidate(item));
  }
  return false;
}
