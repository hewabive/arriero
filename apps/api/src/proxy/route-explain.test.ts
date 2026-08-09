import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import {
  ApiProxyPipelineNodeSchema,
  type ApiProxyRouteTo,
} from "@arriero/core";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint } from "./endpoints.js";
import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyTarget,
} from "./repository.js";
import { explainApiProxyRoute } from "./route-explain.js";
import { estimateRequestTokens } from "./token-estimate.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

function seedTarget(name: string) {
  const endpoint = createApiEndpoint({
    name: `${name}-endpoint`,
    baseUrl: "http://upstream.local",
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    enabled: true,
    apiKey: "",
  });
  return createApiProxyTarget({
    name,
    endpointId: endpoint.id,
    model: null,
    role: "background",
    priority: 100,
    preemptible: false,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  });
}

function seedModel(modelId: string, routeTo: ApiProxyRouteTo) {
  return createApiProxyModel({
    modelId,
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo,
    description: null,
  });
}

function userBody(modelId: string, content: string) {
  return {
    model: modelId,
    messages: [{ role: "user", content }],
  };
}

test("explain resolves a plain target route with the target name", async () => {
  const target = seedTarget("main-target");
  seedModel("plain-model", { type: "target", id: target.id });
  const body = userBody("plain-model", "hello there");

  const result = await explainApiProxyRoute({
    protocol: "openai",
    body,
    sourceId: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.modelId, "plain-model");
  assert.equal(result.targetId, target.id);
  assert.equal(result.targetName, "main-target");
  assert.equal(result.diagnostic, null);
  assert.deepEqual(result.routeTrace, []);
  assert.equal(result.textReplacementCount, 0);
  assert.deepEqual(result.transformedBody, body);
  assert.equal(result.tokenEstimate, estimateRequestTokens(body));
  assert.ok((result.tokenEstimate ?? 0) > 0);
});

test("explain reports replace-text transformations in the transformed body", async () => {
  const target = seedTarget("scrubbed");
  const replace = ApiProxyPipelineNodeSchema.parse({
    id: "replace",
    name: "",
    type: "replace-text",
    config: {
      rules: [
        {
          enabled: true,
          find: "bad text",
          replace: "a considerably longer replacement paragraph",
        },
      ],
      request: true,
    },
    ports: { next: { type: "target", id: target.id } },
  });
  const pipeline = createApiProxyPipeline({
    name: "scrub",
    enabled: true,
    entry: { type: "node", id: "replace" },
    nodes: [replace],
  });
  seedModel("scrub-model", { type: "pipeline", id: pipeline.id });
  const body = userBody("scrub-model", "hello bad text");

  const result = await explainApiProxyRoute({
    protocol: "openai",
    body,
    sourceId: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetId, target.id);
  assert.equal(result.targetName, "scrubbed");
  assert.equal(result.textReplacementCount, 1);
  assert.deepEqual(
    result.transformedBody,
    userBody(
      "scrub-model",
      "hello a considerably longer replacement paragraph",
    ),
  );
  assert.deepEqual(
    result.routeTrace.map((step) => step.kind),
    ["enter-pipeline", "replace-text"],
  );
  assert.equal(result.routeTrace[1]?.detail, "request: 1 replacement(s)");
  assert.equal(result.tokenEstimate, estimateRequestTokens(body));
});

test("explain follows both condition branches", async () => {
  const targetTrue = seedTarget("route-long");
  const targetFalse = seedTarget("route-short");
  const condition = ApiProxyPipelineNodeSchema.parse({
    id: "cond",
    name: "",
    type: "condition",
    config: {
      predicate: {
        type: "text-match",
        scope: "any-message",
        pattern: "escalate",
        regex: false,
        caseSensitive: false,
      },
    },
    ports: {
      true: { type: "target", id: targetTrue.id },
      false: { type: "target", id: targetFalse.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "brancher",
    enabled: true,
    entry: { type: "node", id: "cond" },
    nodes: [condition],
  });
  seedModel("branch-model", { type: "pipeline", id: pipeline.id });

  const matched = await explainApiProxyRoute({
    protocol: "openai",
    body: userBody("branch-model", "please escalate this"),
    sourceId: null,
  });
  assert.equal(matched.ok, true);
  assert.equal(matched.targetId, targetTrue.id);
  assert.equal(matched.targetName, "route-long");
  assert.equal(matched.routeTrace[1]?.kind, "condition");
  assert.equal(matched.routeTrace[1]?.port, "true");

  const missed = await explainApiProxyRoute({
    protocol: "openai",
    body: userBody("branch-model", "all quiet today"),
    sourceId: null,
  });
  assert.equal(missed.ok, true);
  assert.equal(missed.targetId, targetFalse.id);
  assert.equal(missed.targetName, "route-short");
  assert.equal(missed.routeTrace[1]?.port, "false");
});

test("explain resolves call and named exit through the callee pipeline", async () => {
  const matchedTarget = seedTarget("escalation");
  const cleanTarget = seedTarget("regular");
  const calleeCondition = ApiProxyPipelineNodeSchema.parse({
    id: "cond",
    name: "",
    type: "condition",
    config: {
      predicate: {
        type: "text-match",
        scope: "any-message",
        pattern: "bad text",
        regex: false,
        caseSensitive: false,
      },
    },
    ports: {
      true: { type: "node", id: "exit-matched" },
      false: { type: "node", id: "exit-clean" },
    },
  });
  const exitMatched = ApiProxyPipelineNodeSchema.parse({
    id: "exit-matched",
    name: "",
    type: "exit",
    config: { exitName: "matched" },
  });
  const exitClean = ApiProxyPipelineNodeSchema.parse({
    id: "exit-clean",
    name: "",
    type: "exit",
    config: { exitName: "clean" },
  });
  const callee = createApiProxyPipeline({
    name: "classifier",
    enabled: true,
    entry: { type: "node", id: "cond" },
    nodes: [calleeCondition, exitMatched, exitClean],
  });
  const call = ApiProxyPipelineNodeSchema.parse({
    id: "call-fn",
    name: "",
    type: "call",
    config: { pipelineId: callee.id },
    ports: {
      matched: { type: "target", id: matchedTarget.id },
      clean: { type: "target", id: cleanTarget.id },
    },
  });
  const caller = createApiProxyPipeline({
    name: "caller",
    enabled: true,
    entry: { type: "node", id: "call-fn" },
    nodes: [call],
  });
  seedModel("call-model", { type: "pipeline", id: caller.id });

  const result = await explainApiProxyRoute({
    protocol: "openai",
    body: userBody("call-model", "hello bad text"),
    sourceId: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetId, matchedTarget.id);
  assert.equal(result.targetName, "escalation");
  assert.deepEqual(
    result.routeTrace.map((step) => step.kind),
    ["enter-pipeline", "call", "enter-pipeline", "condition", "exit"],
  );
  assert.equal(result.routeTrace[4]?.port, "matched");
});

test("explain reports a fusion pipeline as a panel summary", async () => {
  const panelA = seedTarget("panel-a");
  const panelB = seedTarget("panel-b");
  const synth = seedTarget("synth");
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fuse",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 2 },
    ports: {
      panel: [
        { type: "target", id: panelA.id },
        { type: "target", id: panelB.id },
      ],
      synthesizer: { type: "target", id: synth.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "ensemble",
    enabled: true,
    entry: { type: "node", id: "fuse" },
    nodes: [fusion],
  });
  seedModel("fusion-model", { type: "pipeline", id: pipeline.id });
  const body = userBody("fusion-model", "question");

  const result = await explainApiProxyRoute({
    protocol: "openai",
    body,
    sourceId: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetId, null);
  assert.equal(result.targetName, "fusion (2 panel)");
  assert.deepEqual(
    result.routeTrace.map((step) => step.kind),
    ["enter-pipeline", "fusion"],
  );
  assert.deepEqual(result.transformedBody, body);
});

test("explain fails with a diagnostic when the body has no model", async () => {
  const result = await explainApiProxyRoute({
    protocol: "openai",
    body: {},
    sourceId: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelId, "");
  assert.deepEqual(result.diagnostic, {
    status: 400,
    code: "arriero_proxy_model_unbound",
    message: "Request body has no model field.",
  });
  assert.deepEqual(result.routeTrace, []);
  assert.equal(result.transformedBody, null);
  assert.equal(typeof result.tokenEstimate, "number");
});

test("explain fails with a 404 diagnostic for an unconfigured model", async () => {
  const result = await explainApiProxyRoute({
    protocol: "openai",
    body: userBody("ghost", "hello"),
    sourceId: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelId, "ghost");
  assert.deepEqual(result.diagnostic, {
    status: 404,
    code: "arriero_proxy_model_unbound",
    message: "Model ghost is not configured.",
  });
  assert.equal(result.targetId, null);
  assert.equal(result.targetName, null);
});

test("explain keeps the route trace when resolution fails mid-pipeline", async () => {
  const dangling = ApiProxyPipelineNodeSchema.parse({
    id: "replace",
    name: "",
    type: "replace-text",
    config: { rules: [], request: true },
    ports: { next: null },
  });
  const pipeline = createApiProxyPipeline({
    name: "dead-end",
    enabled: true,
    entry: { type: "node", id: "replace" },
    nodes: [dangling],
  });
  seedModel("dead-end-model", { type: "pipeline", id: pipeline.id });

  const result = await explainApiProxyRoute({
    protocol: "openai",
    body: userBody("dead-end-model", "hello"),
    sourceId: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostic?.status, 503);
  assert.equal(result.diagnostic?.code, "arriero_proxy_route_unbound");
  assert.match(result.diagnostic?.message ?? "", /unwired port/);
  assert.deepEqual(
    result.routeTrace.map((step) => step.kind),
    ["enter-pipeline", "replace-text"],
  );
  assert.equal(result.transformedBody, null);
});
