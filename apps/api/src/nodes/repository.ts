import {
  FleetNodeSchema,
  stripLegacyConfigTimestamps,
  type FleetNode,
  type FleetNodeCreate,
  type FleetNodeUpdate,
} from "@arriero/core";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import { readSecret, setSecret } from "../proxy/config-files.js";
import { newId } from "../utils/id.js";

export const NODES_FILE = resolve(config.configDir, "nodes.json");
const SECRET_PREFIX = "node:";

const StoredFleetNodeSchema: z.ZodType<FleetNode> = z.preprocess(
  stripLegacyConfigTimestamps,
  FleetNodeSchema.catchall(z.unknown()),
);

const store = createJsonFileStore<FleetNode[]>({
  id: "nodes",
  path: NODES_FILE,
  schema: z.array(StoredFleetNodeSchema),
  missing: () => [],
  portablePaths: false,
  cache: "process",
});

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function load(): FleetNode[] {
  return store.read();
}

export function rewriteNodesFile(): void {
  persist(load());
}

function persist(nodes: FleetNode[]) {
  store.write(nodes);
}

function secretKey(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

export function listNodes(): FleetNode[] {
  return [...load()].sort((left, right) => left.name.localeCompare(right.name));
}

export function getNode(id: string): FleetNode | null {
  return load().find((node) => node.id === id) ?? null;
}

export function nodeToken(id: string): string | null {
  return readSecret(secretKey(id));
}

export function nodeHasToken(id: string): boolean {
  return Boolean(nodeToken(id));
}

export function createNode(input: FleetNodeCreate): FleetNode {
  const nodes = load();
  const node: FleetNode = {
    id: newId(),
    name: input.name,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    enabled: input.enabled,
  };
  persist([...nodes, node]);
  if (input.token) {
    setSecret(secretKey(node.id), input.token);
  }
  return node;
}

export function updateNode(
  id: string,
  input: FleetNodeUpdate,
): FleetNode | null {
  const nodes = load();
  const current = nodes.find((node) => node.id === id);
  if (!current) {
    return null;
  }

  const updated: FleetNode = {
    ...current,
    name: input.name ?? current.name,
    baseUrl:
      input.baseUrl !== undefined
        ? normalizeBaseUrl(input.baseUrl)
        : current.baseUrl,
    enabled: input.enabled ?? current.enabled,
  };
  persist(nodes.map((node) => (node.id === id ? updated : node)));
  if (input.token !== undefined) {
    setSecret(secretKey(id), input.token || null);
  }
  return updated;
}

export function deleteNode(id: string): boolean {
  const nodes = load();
  const next = nodes.filter((node) => node.id !== id);
  if (next.length === nodes.length) {
    return false;
  }
  persist(next);
  setSecret(secretKey(id), null);
  return true;
}

export function resetNodesCache(): void {
  store.reset();
}
