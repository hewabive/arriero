import {
  FleetResourcesPayloadSchema,
  SystemResourcesSchema,
  type FleetNode,
  type FleetResourcesEntry,
  type FleetResourcesPayload,
  type FleetSystemEntry,
  type SystemResources,
} from "@arriero/core";
import { hostname } from "node:os";

import { currentResourceLedger } from "../resources/ledger.js";
import { listMemoryPoolsWithStatus } from "../resources/repository.js";
import { getSystemResources } from "../system/resources.js";
import { listPeerNodes } from "./repository.js";
import { fetchNodeJson } from "./remote.js";

type FleetEntry<T> = {
  nodeId: string;
  nodeName: string;
  self: boolean;
  baseUrl: string | null;
  ok: boolean;
  error: string | null;
  data: T | null;
};

function selfEntry<T>(produce: () => T): FleetEntry<T> {
  try {
    return {
      nodeId: "self",
      nodeName: hostname(),
      self: true,
      baseUrl: null,
      ok: true,
      error: null,
      data: produce(),
    };
  } catch (error) {
    return {
      nodeId: "self",
      nodeName: hostname(),
      self: true,
      baseUrl: null,
      ok: false,
      error: (error as Error).message,
      data: null,
    };
  }
}

async function peerEntry<T>(
  node: FleetNode,
  apiPath: string,
  validate: (raw: unknown) => T,
): Promise<FleetEntry<T>> {
  const base: Omit<FleetEntry<T>, "ok" | "error" | "data"> = {
    nodeId: node.id,
    nodeName: node.name,
    self: false,
    baseUrl: node.baseUrl,
  };
  if (!node.enabled) {
    return { ...base, ok: false, error: "node is disabled", data: null };
  }
  try {
    const raw = await fetchNodeJson<unknown>(node, apiPath);
    return { ...base, ok: true, error: null, data: validate(raw) };
  } catch (error) {
    return { ...base, ok: false, error: (error as Error).message, data: null };
  }
}

function localResourcesPayload(): FleetResourcesPayload {
  return {
    pools: listMemoryPoolsWithStatus(),
    ledger: currentResourceLedger(),
    detected: getSystemResources(),
  };
}

export async function fleetSystem(): Promise<FleetSystemEntry[]> {
  const self = selfEntry<SystemResources>(() => getSystemResources());
  const peers = await Promise.all(
    listPeerNodes().map((node) =>
      peerEntry(node, "system/resources", (raw) =>
        SystemResourcesSchema.parse(raw),
      ),
    ),
  );
  return [self, ...peers];
}

export async function fleetResources(): Promise<FleetResourcesEntry[]> {
  const self = selfEntry<FleetResourcesPayload>(localResourcesPayload);
  const peers = await Promise.all(
    listPeerNodes().map((node) =>
      peerEntry(node, "resources", (raw) =>
        FleetResourcesPayloadSchema.parse(raw),
      ),
    ),
  );
  return [self, ...peers];
}
