import {
  FleetNodeSchema,
  type FleetNode,
  type FleetNodeCreate,
  type FleetNodeUpdate,
} from "@arriero/core";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { readSecret, setSecret } from "../proxy/config-files.js";
import { newId } from "../utils/id.js";

export const NODES_FILE = resolve(config.configDir, "nodes.json");
const SECRET_PREFIX = "node:";

let cache: FleetNode[] | null = null;

function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function load(): FleetNode[] {
  if (cache) {
    return cache;
  }
  let nodes: FleetNode[] = [];
  if (existsSync(NODES_FILE)) {
    const raw = readFileSync(NODES_FILE, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${NODES_FILE}: ${(error as Error).message}`,
      );
    }
    const parsed = z.array(FleetNodeSchema).safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Invalid config in ${NODES_FILE}: ${parsed.error.message}`,
      );
    }
    nodes = parsed.data;
  }
  cache = nodes;
  return nodes;
}

function persist(nodes: FleetNode[]) {
  atomicWrite(NODES_FILE, `${JSON.stringify(nodes, null, 2)}\n`);
  cache = nodes;
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
  const timestamp = nowIso();
  const node: FleetNode = {
    id: newId(),
    name: input.name,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    enabled: input.enabled,
    createdAt: timestamp,
    updatedAt: timestamp,
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
    updatedAt: nowIso(),
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
  cache = null;
}
