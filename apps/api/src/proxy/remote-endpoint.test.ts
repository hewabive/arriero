import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import { ApiProxyTargetRecordSchema } from "@arriero/core";

import { config } from "../config.js";
import {
  NODES_FILE,
  createNode,
  resetNodesCache,
} from "../nodes/repository.js";
import { resetConfigFilesCache } from "./config-files.js";
import {
  getApiEndpointById,
  parseRemoteEndpointId,
  referencedRemoteEndpoints,
  remoteEndpointId,
} from "./endpoints.js";
import { resolveApiProxyTarget } from "./targets.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  rmSync(NODES_FILE, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  resetNodesCache();
});

function seedNode(enabled = true) {
  return createNode({
    name: "peer-ny",
    baseUrl: "http://peer-host:8787",
    enabled,
  });
}

function remoteTarget(endpointId: string) {
  return ApiProxyTargetRecordSchema.parse({
    id: "t1",
    name: "remote-target",
    endpointId,
    model: null,
    role: "interactive",
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  });
}

test("remoteEndpointId round-trips through parseRemoteEndpointId", () => {
  const id = remoteEndpointId("0192-node", "qwen-big");
  assert.equal(id, "remote:0192-node:qwen-big");
  assert.deepEqual(parseRemoteEndpointId(id), {
    nodeId: "0192-node",
    instanceId: "qwen-big",
  });
  assert.equal(parseRemoteEndpointId("instance:qwen-big"), null);
});

test("getApiEndpointById synthesizes a remote endpoint from the node registry", () => {
  const node = seedNode();
  const endpoint = getApiEndpointById(
    remoteEndpointId(node.id, "qwen-big"),
    [],
  );
  assert.equal(endpoint?.kind, "managed-instance");
  assert.equal(endpoint?.nodeId, node.id);
  assert.equal(endpoint?.instanceId, "qwen-big");
  assert.equal(endpoint?.enabled, true);
  assert.equal(endpoint?.editable, false);
});

test("getApiEndpointById returns null for an unknown node", () => {
  const endpoint = getApiEndpointById(
    remoteEndpointId("ghost-node", "qwen-big"),
    [],
  );
  assert.equal(endpoint, null);
});

test("referencedRemoteEndpoints resolves only ids that map to a known node", () => {
  const node = seedNode();
  const records = referencedRemoteEndpoints([
    remoteEndpointId(node.id, "qwen-big"),
    remoteEndpointId("ghost-node", "missing"),
    "instance:local-only",
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.instanceId, "qwen-big");
  assert.equal(records[0]?.nodeId, node.id);
});

test("resolveApiProxyTarget treats a remote endpoint as non-local on the entry node", () => {
  const node = seedNode();
  const endpointId = remoteEndpointId(node.id, "qwen-big");
  const endpoint = getApiEndpointById(endpointId, []);
  assert.ok(endpoint);
  const resolution = resolveApiProxyTarget(
    remoteTarget(endpointId),
    [],
    [endpoint],
  );
  assert.equal(resolution.enabled, true);
  assert.equal(resolution.instanceId, null);
  assert.equal(resolution.error, null);
});

test("a remote endpoint on a disabled node resolves disabled without a missing-instance error", () => {
  const node = seedNode(false);
  const endpointId = remoteEndpointId(node.id, "qwen-big");
  const endpoint = getApiEndpointById(endpointId, []);
  assert.ok(endpoint);
  const resolution = resolveApiProxyTarget(
    remoteTarget(endpointId),
    [],
    [endpoint],
  );
  assert.equal(resolution.enabled, false);
  assert.match(resolution.error ?? "", /disabled/);
});
