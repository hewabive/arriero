import { strict as assert } from "node:assert";
import test from "node:test";

import type { FleetNode } from "@arriero/core";

import {
  createNode,
  deleteNode,
  getNode,
  listNodes,
  nodeToken,
  resetNodesCache,
  updateNode,
} from "./repository.js";
import { fleetSystem } from "./fleet.js";
import { localFederationCapabilities } from "./capabilities.js";
import { nodeApiUrl, nodeProxyRest } from "./remote.js";

test("createNode normalizes baseUrl and stores the token as a secret", () => {
  resetNodesCache();
  const node = createNode({
    name: "workstation",
    baseUrl: "http://10.0.0.2:8787/",
    enabled: true,
    token: "s3cret",
  });

  assert.equal(node.baseUrl, "http://10.0.0.2:8787");
  assert.equal(getNode(node.id)?.name, "workstation");
  assert.equal(nodeToken(node.id), "s3cret");

  deleteNode(node.id);
});

test("updateNode patches fields and clears the token with an empty string", () => {
  resetNodesCache();
  const node = createNode({
    name: "a",
    baseUrl: "http://10.0.0.3:8787",
    enabled: true,
    token: "tok",
  });

  const updated = updateNode(node.id, { name: "b", enabled: false, token: "" });
  assert.equal(updated?.name, "b");
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.baseUrl, "http://10.0.0.3:8787");
  assert.equal(nodeToken(node.id), null);

  assert.equal(updateNode("missing", { name: "x" }), null);

  deleteNode(node.id);
});

test("deleteNode removes the node and its token", () => {
  resetNodesCache();
  const node = createNode({
    name: "gone",
    baseUrl: "http://10.0.0.4:8787",
    enabled: true,
    token: "tok",
  });

  assert.equal(deleteNode(node.id), true);
  assert.equal(getNode(node.id), null);
  assert.equal(nodeToken(node.id), null);
  assert.equal(deleteNode(node.id), false);
  assert.ok(!listNodes().some((entry) => entry.id === node.id));
});

test("fleetSystem always includes a healthy self entry and marks a disabled peer", async () => {
  resetNodesCache();
  const disabled = createNode({
    name: "z-disabled",
    baseUrl: "http://10.0.0.9:8787",
    enabled: false,
  });

  const entries = await fleetSystem();

  const self = entries.find((entry) => entry.self);
  assert.ok(self);
  assert.equal(self.nodeId, "self");
  assert.equal(self.ok, true);
  assert.ok(self.data);

  const peer = entries.find((entry) => entry.nodeId === disabled.id);
  assert.ok(peer);
  assert.equal(peer.ok, false);
  assert.equal(peer.error, "node is disabled");
  assert.equal(peer.data, null);

  deleteNode(disabled.id);
});

test("nodeApiUrl and nodeProxyRest map the proxy prefix to the peer /api path", () => {
  const node: FleetNode = {
    id: "n1",
    name: "peer",
    baseUrl: "http://10.0.0.5:8787",
    enabled: true,
  };

  assert.equal(
    nodeApiUrl(node, "instances/foo"),
    "http://10.0.0.5:8787/api/instances/foo",
  );
  assert.equal(
    nodeProxyRest(node, "/api/nodes/n1/instances/foo"),
    "instances/foo",
  );
  assert.equal(nodeProxyRest(node, "/api/nodes/n1/health"), "health");
  assert.equal(nodeApiUrl(node, "/health"), "http://10.0.0.5:8787/api/health");
});

test("federation capabilities advertise creatable KTransformers support", () => {
  const capabilities = localFederationCapabilities();
  assert.equal(capabilities.protocolVersion, 1);
  assert.ok(capabilities.instanceKinds.includes("ktransformers"));
  assert.equal(
    capabilities.creatableInstanceKinds.includes("ktransformers"),
    true,
  );
  assert.equal(capabilities.unknownInstanceKindsTolerated, true);
});
