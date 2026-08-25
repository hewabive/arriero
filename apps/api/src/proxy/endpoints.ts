import {
  ApiEndpointCreateSchema,
  ApiEndpointRecordSchema,
  ApiEndpointUpdateSchema,
  type ApiEndpointCreateInput,
  type ApiEndpointRecord,
  type ApiEndpointUpdate,
  engineDescriptor,
  type FleetNode,
  type Instance,
  instanceEndpointId,
  instanceIdFromEndpointId,
  stripLegacyConfigTimestamps,
} from "@arriero/core";
import { z } from "zod";
import { newId } from "../utils/id.js";
import { sortedByKey } from "../utils/sort.js";

import { config } from "../config.js";
import { listRemoteInstancesByNode } from "../nodes/remote-instances.js";
import { getNode } from "../nodes/repository.js";
import { runtimeInstanceBaseUrl } from "../process/runtime-endpoint.js";
import {
  readCollection,
  readSecret,
  setSecret,
  writeCollection,
} from "./config-files.js";
import { apiVersionBaseUrl } from "./targets.js";

export const ENDPOINTS_FILE = "endpoints.json";

const StoredEndpointBaseSchema = ApiEndpointRecordSchema.pick({
  id: true,
  name: true,
  enabled: true,
  baseUrl: true,
  profile: true,
  apiKeyEnvVar: true,
  authHeaderName: true,
  extraHeaders: true,
  passthrough: true,
  modelFilter: true,
  reasoning: true,
  streamTerminal: true,
  streamIdleTimeoutMs: true,
});

type StoredEndpoint = z.infer<typeof StoredEndpointBaseSchema>;

export const StoredEndpointSchema: z.ZodType<StoredEndpoint> = z.preprocess(
  stripLegacyConfigTimestamps,
  StoredEndpointBaseSchema.catchall(z.unknown()),
);

export const managerProxyEndpointId = "manager-proxy";
const REMOTE_ENDPOINT_PREFIX = "remote:";

export { instanceEndpointId };

export function remoteEndpointId(nodeId: string, instanceId: string) {
  return `${REMOTE_ENDPOINT_PREFIX}${nodeId}:${instanceId}`;
}

export function parseRemoteEndpointId(
  id: string,
): { nodeId: string; instanceId: string } | null {
  if (!id.startsWith(REMOTE_ENDPOINT_PREFIX)) {
    return null;
  }
  const rest = id.slice(REMOTE_ENDPOINT_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator >= rest.length - 1) {
    return null;
  }
  return {
    nodeId: rest.slice(0, separator),
    instanceId: rest.slice(separator + 1),
  };
}

function readStoredEndpoints(): StoredEndpoint[] {
  return readCollection(ENDPOINTS_FILE, StoredEndpointSchema);
}

function persistEndpoints(records: StoredEndpoint[]) {
  writeCollection(
    ENDPOINTS_FILE,
    StoredEndpointSchema,
    sortedByKey(records, (item) => item.name),
  );
}

export function rewriteStoredEndpoints(): void {
  persistEndpoints(readStoredEndpoints());
}

function assertUniqueName(
  records: StoredEndpoint[],
  name: string,
  exceptId: string | null,
) {
  if (records.some((item) => item.name === name && item.id !== exceptId)) {
    throw new Error(`API endpoint name already exists: ${name}`);
  }
}

function toExternalEndpoint(stored: StoredEndpoint): ApiEndpointRecord {
  return ApiEndpointRecordSchema.parse({
    id: stored.id,
    name: stored.name,
    enabled: stored.enabled,
    kind: "external-api",
    baseUrl: stored.baseUrl,
    profile: stored.profile,
    apiKeyEnvVar: stored.apiKeyEnvVar,
    authHeaderName: stored.authHeaderName,
    extraHeaders: stored.extraHeaders,
    passthrough: stored.passthrough,
    modelFilter: stored.modelFilter,
    reasoning: stored.reasoning,
    streamTerminal: stored.streamTerminal,
    streamIdleTimeoutMs: stored.streamIdleTimeoutMs,
    instanceId: null,
    editable: true,
    authConfigured:
      Boolean(readSecret(stored.id)) || Boolean(stored.apiKeyEnvVar),
  });
}

function remoteInstanceEndpoint(
  node: FleetNode,
  instanceId: string,
): ApiEndpointRecord {
  return ApiEndpointRecordSchema.parse({
    id: remoteEndpointId(node.id, instanceId),
    name: `${node.name} / ${instanceId}`,
    enabled: node.enabled,
    kind: "managed-instance",
    baseUrl: node.baseUrl,
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    instanceId,
    nodeId: node.id,
    editable: false,
    authConfigured: true,
  });
}

function managerProxyBaseUrl() {
  const host =
    config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host;
  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${config.port}/v1`;
}

function managerProxyEndpoint(): ApiEndpointRecord {
  return ApiEndpointRecordSchema.parse({
    id: managerProxyEndpointId,
    name: "arriero proxy",
    enabled: true,
    kind: "manager-proxy",
    baseUrl: managerProxyBaseUrl(),
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    instanceId: null,
    editable: false,
    authConfigured: true,
  });
}

function instanceEndpoint(instance: Instance): ApiEndpointRecord | null {
  if (!engineDescriptor(instance.kind).proxy.serveEndpoint) {
    return null;
  }
  const baseUrl = runtimeInstanceBaseUrl(instance);
  if (!baseUrl) {
    return null;
  }

  return ApiEndpointRecordSchema.parse({
    id: instanceEndpointId(instance.name),
    name: instance.name,
    enabled: true,
    kind: "managed-instance",
    baseUrl: apiVersionBaseUrl(baseUrl),
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    instanceId: instance.name,
    editable: false,
    authConfigured: true,
  });
}

function listStoredEndpointRecords(): ApiEndpointRecord[] {
  return readStoredEndpoints()
    .map(toExternalEndpoint)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getStoredExternalApiEndpoint(id: string): StoredEndpoint | null {
  return readStoredEndpoints().find((item) => item.id === id) ?? null;
}

export function listPassthroughEndpoints(): ApiEndpointRecord[] {
  return listStoredEndpointRecords().filter(
    (endpoint) => endpoint.enabled && endpoint.passthrough,
  );
}

export function getExternalApiEndpoint(id: string): ApiEndpointRecord | null {
  const stored = getStoredExternalApiEndpoint(id);
  return stored ? toExternalEndpoint(stored) : null;
}

export function listApiEndpointCatalog(
  instances: Instance[],
): ApiEndpointRecord[] {
  return [
    managerProxyEndpoint(),
    ...instances
      .map(instanceEndpoint)
      .filter((endpoint): endpoint is ApiEndpointRecord => Boolean(endpoint)),
    ...listStoredEndpointRecords(),
  ];
}

export function getApiEndpointById(
  id: string,
  instances: Instance[],
): ApiEndpointRecord | null {
  if (id === managerProxyEndpointId) {
    return managerProxyEndpoint();
  }
  const instanceName = instanceIdFromEndpointId(id);
  if (instanceName !== null) {
    const instance = instances.find((item) => item.name === instanceName);
    return instance ? instanceEndpoint(instance) : null;
  }
  const remote = parseRemoteEndpointId(id);
  if (remote) {
    const node = getNode(remote.nodeId);
    return node ? remoteInstanceEndpoint(node, remote.instanceId) : null;
  }
  return getExternalApiEndpoint(id);
}

export async function listRemoteInstanceEndpoints(): Promise<
  ApiEndpointRecord[]
> {
  const byNode = await listRemoteInstancesByNode();
  return byNode
    .flatMap(({ node, instances }) =>
      instances
        .filter(
          (instance) => engineDescriptor(instance.kind).proxy.serveEndpoint,
        )
        .map((instance) => remoteInstanceEndpoint(node, instance.name)),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function referencedRemoteEndpoints(
  endpointIds: Iterable<string>,
): ApiEndpointRecord[] {
  const seen = new Set<string>();
  const records: ApiEndpointRecord[] = [];
  for (const id of endpointIds) {
    if (seen.has(id)) {
      continue;
    }
    const remote = parseRemoteEndpointId(id);
    if (!remote) {
      continue;
    }
    const node = getNode(remote.nodeId);
    if (!node) {
      continue;
    }
    seen.add(id);
    records.push(remoteInstanceEndpoint(node, remote.instanceId));
  }
  return records;
}

export function getApiEndpointFromCatalog(
  endpointId: string,
  instances: Instance[],
): ApiEndpointRecord | null {
  return (
    listApiEndpointCatalog(instances).find(
      (endpoint) => endpoint.id === endpointId,
    ) ?? null
  );
}

export function createApiEndpoint(
  input: ApiEndpointCreateInput,
): ApiEndpointRecord {
  const parsed = ApiEndpointCreateSchema.parse(input);
  const records = readStoredEndpoints();
  assertUniqueName(records, parsed.name, null);
  const id = newId();
  const stored = StoredEndpointSchema.parse({
    id,
    name: parsed.name,
    enabled: parsed.enabled,
    baseUrl: parsed.baseUrl,
    profile: parsed.profile,
    apiKeyEnvVar: parsed.apiKeyEnvVar,
    authHeaderName: parsed.authHeaderName,
    extraHeaders: parsed.extraHeaders,
    passthrough: parsed.passthrough,
    modelFilter: parsed.modelFilter,
    reasoning: parsed.reasoning,
    streamTerminal: parsed.streamTerminal,
    streamIdleTimeoutMs: parsed.streamIdleTimeoutMs,
  });
  persistEndpoints([...records, stored]);

  if (parsed.apiKey && !parsed.apiKeyEnvVar) {
    setSecret(id, parsed.apiKey);
  }

  const created = getExternalApiEndpoint(id);
  if (!created) {
    throw new Error("failed to create API endpoint");
  }
  return created;
}

export function updateApiEndpoint(
  id: string,
  input: ApiEndpointUpdate,
): ApiEndpointRecord | null {
  const records = readStoredEndpoints();
  const current = records.find((item) => item.id === id);
  if (!current) {
    return null;
  }
  const parsed = ApiEndpointUpdateSchema.parse(input);
  const next = StoredEndpointSchema.parse({
    ...current,
    id: current.id,
    name: parsed.name ?? current.name,
    enabled: parsed.enabled ?? current.enabled,
    baseUrl: parsed.baseUrl ?? current.baseUrl,
    profile: parsed.profile ?? current.profile,
    apiKeyEnvVar:
      parsed.apiKeyEnvVar !== undefined
        ? parsed.apiKeyEnvVar
        : current.apiKeyEnvVar,
    authHeaderName:
      parsed.authHeaderName !== undefined
        ? parsed.authHeaderName
        : current.authHeaderName,
    extraHeaders: parsed.extraHeaders ?? current.extraHeaders,
    passthrough: parsed.passthrough ?? current.passthrough,
    modelFilter:
      parsed.modelFilter !== undefined
        ? parsed.modelFilter
        : current.modelFilter,
    reasoning:
      parsed.reasoning !== undefined ? parsed.reasoning : current.reasoning,
    streamTerminal:
      parsed.streamTerminal !== undefined
        ? parsed.streamTerminal
        : current.streamTerminal,
    streamIdleTimeoutMs:
      parsed.streamIdleTimeoutMs !== undefined
        ? parsed.streamIdleTimeoutMs
        : current.streamIdleTimeoutMs,
  });
  assertUniqueName(records, next.name, id);
  persistEndpoints(records.map((item) => (item.id === id ? next : item)));

  if (next.apiKeyEnvVar) {
    setSecret(id, null);
  } else if (parsed.apiKey !== undefined) {
    setSecret(id, parsed.apiKey || null);
  }

  return getExternalApiEndpoint(id);
}

export function deleteApiEndpoint(id: string): boolean {
  const records = readStoredEndpoints();
  if (!records.some((item) => item.id === id)) {
    return false;
  }
  persistEndpoints(records.filter((item) => item.id !== id));
  setSecret(id, null);
  return true;
}

export function apiEndpointAuthHeaders(
  endpointId: string,
):
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string } {
  const stored = getStoredExternalApiEndpoint(endpointId);
  if (!stored) {
    return { ok: true, headers: {} };
  }

  const headers: Record<string, string> = {};

  const key = stored.apiKeyEnvVar
    ? (process.env[stored.apiKeyEnvVar] ?? null)
    : readSecret(stored.id);
  if (stored.apiKeyEnvVar && !key) {
    return {
      ok: false,
      error: `API endpoint ${stored.name} has no value in env var ${stored.apiKeyEnvVar}`,
    };
  }

  if (key) {
    const override = stored.authHeaderName?.trim();
    if (override) {
      headers[override] = key;
    } else if (stored.profile === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["authorization"] = `Bearer ${key}`;
    }
  }

  for (const [name, value] of Object.entries(stored.extraHeaders)) {
    headers[name] = value;
  }

  return { ok: true, headers };
}
