import {
  InstanceEnvSchema,
  type Instance,
  type ArgumentOption,
} from "@arriero/core";

import { pathBaseName } from "../utils/models";
import { type ArgRow } from "./InstanceArgumentRows";

export type LaunchMode = "model" | "router" | "remote";
export type RemoteSource = "hf" | "url";
export type DraftSource = "local" | "hf";

export const SPEC_DRAFT_MODEL_KEY = "--spec-draft-model";
export const SPEC_DRAFT_HF_KEY = "--spec-draft-hf";
export const SPEC_TYPE_KEY = "--spec-type";
export const SPEC_ADVANCED_KEYS = [
  "--spec-draft-n-max",
  "--spec-draft-n-min",
  "--spec-draft-p-min",
  "--spec-draft-ngl",
  "--spec-draft-threads",
  "--spec-draft-device",
] as const;
export const SPEC_KEYS = [
  SPEC_DRAFT_MODEL_KEY,
  SPEC_DRAFT_HF_KEY,
  SPEC_TYPE_KEY,
  ...SPEC_ADVANCED_KEYS,
];

function parseJsonObject(value: string, field: string) {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${field} must be an object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`${field}: ${(error as Error).message}`);
  }
}

export function parseEnvJson(value: string) {
  return InstanceEnvSchema.parse(parseJsonObject(value, "env"));
}

export function hasOwnKey(record: Record<string, string>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export type EnvRow = { id: string; key: string; value: string };

export const MANAGED_ENV_KEYS = new Set(["CUDA_VISIBLE_DEVICES", "HF_TOKEN"]);

export function envRowsToRecord(rows: EnvRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || MANAGED_ENV_KEYS.has(key)) {
      continue;
    }
    record[key] = row.value;
  }
  return record;
}

export function isSecretEnvKey(key: string): boolean {
  return (
    /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY)/i.test(
      key,
    ) || /(?:^|_)KEY$/i.test(key)
  );
}

export function splitCudaVisibleDevices(value: string | undefined) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function argString(args: Instance["args"], key: string) {
  const value = args[key];
  if (value === undefined || value === null || Array.isArray(value)) {
    return "";
  }
  return String(value);
}

export function hasConfiguredArg(args: Instance["args"], key: string) {
  const value = args[key];
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return Boolean(value.trim());
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

export function isSelectableInstanceArgument(option: ArgumentOption) {
  return (
    option.primaryName.startsWith("-") &&
    option.compatibility.presentInBinary &&
    option.compatibility.binaryNames.length > 0
  );
}

export function hasModelSource(args: Instance["args"]) {
  return (
    hasConfiguredArg(args, "--model") ||
    hasConfiguredArg(args, "--models-preset") ||
    hasConfiguredArg(args, "--hf-repo") ||
    hasConfiguredArg(args, "--model-url")
  );
}

function hasRemoteModelSource(args: Instance["args"]) {
  return (
    hasConfiguredArg(args, "--hf-repo") || hasConfiguredArg(args, "--model-url")
  );
}

export function hasSpecConfig(args: Instance["args"]) {
  return SPEC_KEYS.some((key) => hasConfiguredArg(args, key));
}

export function launchModeFromArgs(args: Instance["args"]): LaunchMode {
  if (hasConfiguredArg(args, "--models-preset")) {
    return "router";
  }
  if (hasRemoteModelSource(args)) {
    return "remote";
  }
  return "model";
}

export const RPC_WORKER_DEFAULT_PORT = 50052;

function instancePort(instance: Instance) {
  const port = Number(instance.args["--port"] ?? 8080);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function nextAvailablePort(
  instances: Instance[],
  currentName?: string,
  startPort = 8080,
) {
  const used = new Set(
    instances
      .filter((instance) => instance.name !== currentName)
      .map((instance) => instancePort(instance))
      .filter((port): port is number => port !== null),
  );

  for (let port = startPort; port <= 65535; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }
  return startPort;
}

const managedArgumentKeys = new Set([
  "--host",
  "--port",
  "--model",
  "--models-preset",
  "--hf-repo",
  "--hf-file",
  "--model-url",
  "--mmproj-url",
  ...SPEC_KEYS,
]);

export function isManagedArgRow(row: ArgRow) {
  return managedArgumentKeys.has(row.key.trim());
}

export function presetNameFromPath(path: string) {
  return pathBaseName(path).replace(/\.ini$/i, "");
}

export function duplicateInstanceName(
  sourceName: string,
  instances: Instance[],
) {
  const taken = new Set(instances.map((instance) => instance.name));
  let candidate = `${sourceName}-copy`;
  for (let index = 2; taken.has(candidate); index += 1) {
    candidate = `${sourceName}-copy-${index}`;
  }
  return candidate;
}
