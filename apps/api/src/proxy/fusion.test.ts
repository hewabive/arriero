import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, test } from "node:test";

import {
  ApiProxyPipelineNodeSchema,
  type ApiProxyModelRecord,
} from "@arriero/core";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint } from "./endpoints.js";
import {
  executeApiProxyFusion,
  executeApiProxyModelSubRequest,
  type ApiProxyFusionChainIo,
} from "./fusion.js";
import {
  bodyRequestsStreaming,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import { createProxyTrace } from "./protocol-trace.js";
import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyTarget,
} from "./repository.js";
import {
  findApiProxyInFlight,
  registerApiProxyInFlight,
} from "./response-coalesce.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

const chatOperation: ApiProxyProtocolOperation = {
  protocol: "openai",
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json",
};

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAiSseFetch(frames: string[]): typeof fetch {
  return (async () => sseResponse(frames)) as unknown as typeof fetch;
}

function answerFrames(text: string): string[] {
  return [deltaFrame(text, "stop"), "data: [DONE]\n\n"];
}

function routedFetch(routes: Array<[string, () => Response]>): typeof fetch {
  return (async (url: string) => {
    for (const [needle, make] of routes) {
      if (String(url).includes(needle)) {
        return make();
      }
    }
    return new Response("unrouted", { status: 404 });
  }) as unknown as typeof fetch;
}

function deltaFrame(content: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "c",
    model: "m",
    choices: [{ delta: { content }, finish_reason: finish }],
  })}\n\n`;
}

function seedExternalTarget(name: string, baseUrl = "http://fake.local") {
  const endpoint = createApiEndpoint({
    name: `${name}-endpoint`,
    baseUrl,
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

function seedFusionPipeline(opts: {
  panel: string[];
  synthesizer: string;
  minQuorum: number;
}) {
  const node = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: opts.minQuorum },
    ports: {
      panel: opts.panel.map((id) => ({ type: "target", id })),
      synthesizer: { type: "target", id: opts.synthesizer },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "fuse-pipeline",
    enabled: true,
    entry: { type: "node", id: node.id },
    nodes: [node],
  });
  const fusionNode = pipeline.nodes.find((item) => item.type === "fusion");
  assert.ok(fusionNode && fusionNode.type === "fusion");
  return { pipeline, node: fusionNode };
}

let seededModelCounter = 0;
function fusionRequest(body: unknown): ApiProxyProtocolModelRequest {
  seededModelCounter += 1;
  const model: ApiProxyModelRecord = createApiProxyModel({
    modelId: `fusion-model-${seededModelCounter}`,
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo: null,
    description: null,
    blockedMessage: "",
    reasoning: null,
  });
  return {
    operation: chatOperation,
    body,
    modelId: model.modelId,
    model,
    stream: bodyRequestsStreaming(body),
  };
}

test("fusion routes to the synthesizer with joined panel answers", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const { pipeline, node } = seedFusionPipeline({
    panel: [a.id, b.id],
    synthesizer: synth.id,
    minQuorum: 2,
  });

  const outcome = await executeApiProxyFusion({
    node,
    pipeline,
    request: fusionRequest({
      model: "m",
      messages: [{ role: "user", content: "question" }],
    }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Alpha answer"))],
      ["panel-b.local", () => sseResponse(answerFrames("Beta answer"))],
    ]),
  });

  assert.equal(outcome.kind, "route");
  if (outcome.kind === "route") {
    assert.equal(outcome.targetId, synth.id);
    const serialized = JSON.stringify(outcome.request.body);
    assert.match(serialized, /Alpha answer/);
    assert.match(serialized, /Beta answer/);
    assert.match(serialized, /final responder in an ensemble/);
  }
});

test("fusion bypasses the synthesizer when only one panel survives", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const { pipeline, node } = seedFusionPipeline({
    panel: [a.id, b.id],
    synthesizer: synth.id,
    minQuorum: 1,
  });

  const outcome = await executeApiProxyFusion({
    node,
    pipeline,
    request: fusionRequest({ model: "m", messages: [] }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Solo answer"))],
      ["panel-b.local", () => new Response("down", { status: 500 })],
    ]),
  });

  assert.equal(outcome.kind, "direct");
  if (outcome.kind === "direct") {
    assert.match(outcome.response.body, /Solo answer/);
  }
});

test("single-survivor fusion carries the panel branch response plan", async () => {
  const target = seedExternalTarget("panel-a", "http://panel-a.local");
  const failed = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const replace = ApiProxyPipelineNodeSchema.parse({
    id: "panel-replace",
    name: "panel response",
    type: "replace-text",
    config: {
      request: false,
      response: true,
      rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
    },
    ports: { next: { type: "target", id: target.id } },
  });
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 1 },
    ports: {
      panel: [
        { type: "node", id: replace.id },
        { type: "target", id: failed.id },
      ],
      synthesizer: { type: "target", id: synth.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "panel-effects",
    enabled: true,
    entry: { type: "node", id: fusion.id },
    nodes: [fusion, replace],
  });
  const fusionNode = pipeline.nodes.find((node) => node.id === fusion.id);
  assert.ok(fusionNode?.type === "fusion");

  const outcome = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request: fusionRequest({ model: "m", messages: [] }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("secret"))],
      ["panel-b.local", () => new Response("down", { status: 500 })],
    ]),
  });

  assert.equal(outcome.kind, "direct");
  if (outcome.kind === "direct") {
    assert.equal(outcome.responseEffects[0]?.type, "replace-response-text");
  }
});

test("fusion carries the synthesizer branch response plan to the final target", async () => {
  const panelA = seedExternalTarget("panel-a", "http://panel-a.local");
  const panelB = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const scale = ApiProxyPipelineNodeSchema.parse({
    id: "synth-scale",
    name: "virtual context",
    type: "token-scale",
    config: { factor: 10 },
    ports: { next: { type: "target", id: synth.id } },
  });
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 2 },
    ports: {
      panel: [
        { type: "target", id: panelA.id },
        { type: "target", id: panelB.id },
      ],
      synthesizer: { type: "node", id: scale.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "synth-effects",
    enabled: true,
    entry: { type: "node", id: fusion.id },
    nodes: [fusion, scale],
  });
  const fusionNode = pipeline.nodes.find((node) => node.id === fusion.id);
  assert.ok(fusionNode?.type === "fusion");

  const outcome = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request: fusionRequest({
      model: "m",
      max_tokens: 40_000,
      messages: [],
    }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Alpha"))],
      ["panel-b.local", () => sseResponse(answerFrames("Beta"))],
    ]),
  });

  assert.equal(outcome.kind, "route");
  if (outcome.kind === "route") {
    assert.equal(outcome.targetId, synth.id);
    assert.equal(
      (outcome.request.body as { max_tokens: number }).max_tokens,
      4_000,
    );
    assert.deepEqual(outcome.responseEffects, [
      { type: "token-scale", factor: 10 },
    ]);
  }
});

test("fusion errors when the quorum is not met", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const { pipeline, node } = seedFusionPipeline({
    panel: [a.id, b.id],
    synthesizer: synth.id,
    minQuorum: 2,
  });

  const outcome = await executeApiProxyFusion({
    node,
    pipeline,
    request: fusionRequest({ model: "m", messages: [] }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Only one"))],
      ["panel-b.local", () => new Response("down", { status: 500 })],
    ]),
  });

  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    assert.match(outcome.diagnostic.message, /quorum/);
  }
});

function chainIo(
  overrides: Partial<ApiProxyFusionChainIo> = {},
): ApiProxyFusionChainIo {
  return {
    trace: createProxyTrace(chatOperation),
    putCache: () => {},
    ...overrides,
  };
}

test("panel branch response effects apply to the panel answer before synthesis", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const replace = ApiProxyPipelineNodeSchema.parse({
    id: "panel-replace",
    name: "redact",
    type: "replace-text",
    config: {
      request: false,
      response: true,
      rules: [{ enabled: true, find: "secret-host", replace: "[hidden]" }],
    },
    ports: { next: { type: "target", id: a.id } },
  });
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 2 },
    ports: {
      panel: [
        { type: "node", id: replace.id },
        { type: "target", id: b.id },
      ],
      synthesizer: { type: "target", id: synth.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "panel-redact",
    enabled: true,
    entry: { type: "node", id: fusion.id },
    nodes: [fusion, replace],
  });
  const fusionNode = pipeline.nodes.find((node) => node.id === fusion.id);
  assert.ok(fusionNode?.type === "fusion");

  const io = chainIo();
  const outcome = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request: fusionRequest({ model: "m", messages: [] }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("found secret-host"))],
      ["panel-b.local", () => sseResponse(answerFrames("nothing here"))],
    ]),
    io,
  });

  assert.equal(outcome.kind, "route");
  if (outcome.kind === "route") {
    const serialized = JSON.stringify(outcome.request.body);
    assert.match(serialized, /\[hidden\]/);
    assert.doesNotMatch(serialized, /secret-host/);
    const panelBranch = outcome.branches.find(
      (branch) => branch.branch === "panel 1",
    );
    assert.equal(panelBranch?.textReplacementCount, 1);
  }
});

test("fusion synth body keeps an array-form anthropic system prompt", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const { pipeline, node } = seedFusionPipeline({
    panel: [a.id, b.id],
    synthesizer: synth.id,
    minQuorum: 2,
  });

  const anthropicOperation: ApiProxyProtocolOperation = {
    protocol: "anthropic",
    endpoint: "messages",
    routePath: "/v1/messages",
    transport: "http-json",
  };
  const base = fusionRequest({
    model: "m",
    system: [
      {
        type: "text",
        text: "Persona rules",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "question" }],
  });
  const outcome = await executeApiProxyFusion({
    node,
    pipeline,
    request: { ...base, operation: anthropicOperation },
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Alpha"))],
      ["panel-b.local", () => sseResponse(answerFrames("Beta"))],
    ]),
  });

  assert.equal(outcome.kind, "route");
  if (outcome.kind === "route") {
    const body = outcome.request.body as { system: unknown };
    assert.ok(Array.isArray(body.system));
    const system = body.system as Array<{ type: string; text?: string }>;
    assert.match(system[0]?.text ?? "", /final responder in an ensemble/);
    assert.equal(system[1]?.text, "Persona rules");
  }
});

test("capture-request on a panel branch records the panel body", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const capture = ApiProxyPipelineNodeSchema.parse({
    id: "panel-capture",
    name: "inspect",
    type: "capture-request",
    config: { request: true, response: false },
    ports: { next: { type: "target", id: a.id } },
  });
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 2 },
    ports: {
      panel: [
        { type: "node", id: capture.id },
        { type: "target", id: b.id },
      ],
      synthesizer: { type: "target", id: synth.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "panel-capture",
    enabled: true,
    entry: { type: "node", id: fusion.id },
    nodes: [fusion, capture],
  });
  const fusionNode = pipeline.nodes.find((node) => node.id === fusion.id);
  assert.ok(fusionNode?.type === "fusion");

  const recorded: unknown[] = [];
  const outcome = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request: fusionRequest({ model: "m", messages: [], stream: true }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Alpha"))],
      ["panel-b.local", () => sseResponse(answerFrames("Beta"))],
    ]),
    io: chainIo({
      recordRequest: (request) => {
        recorded.push(request.requestBody);
      },
    }),
  });

  assert.equal(outcome.kind, "route");
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], { model: "m", messages: [] });
});

test("a cache node on a panel branch stores and replays the panel answer", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const b = seedExternalTarget("panel-b", "http://panel-b.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const cache = ApiProxyPipelineNodeSchema.parse({
    id: "panel-cache",
    name: "memo",
    type: "cache",
    config: { ttlSeconds: 600, namespace: "panel" },
    ports: { next: { type: "target", id: a.id } },
  });
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 2 },
    ports: {
      panel: [
        { type: "node", id: cache.id },
        { type: "target", id: b.id },
      ],
      synthesizer: { type: "target", id: synth.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "panel-cache",
    enabled: true,
    entry: { type: "node", id: fusion.id },
    nodes: [fusion, cache],
  });
  const fusionNode = pipeline.nodes.find((node) => node.id === fusion.id);
  assert.ok(fusionNode?.type === "fusion");

  const stored = new Map<
    string,
    { status: number; contentType: string; isSse: boolean; body: string }
  >();
  const firstIo = chainIo({
    putCache: (input) =>
      stored.set(input.key, {
        status: input.status,
        contentType: input.contentType,
        isSse: input.isSse,
        body: input.body,
      }),
  });
  const request = fusionRequest({ model: "m", messages: [] });
  const first = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request,
    fetchImpl: routedFetch([
      ["panel-a.local", () => sseResponse(answerFrames("Cached alpha"))],
      ["panel-b.local", () => sseResponse(answerFrames("Beta"))],
    ]),
    io: firstIo,
  });
  assert.equal(first.kind, "route");
  assert.equal(stored.size, 1);
  const entry = [...stored.values()][0];
  assert.ok(entry);
  assert.equal(entry.isSse, false);
  assert.match(entry.body, /Cached alpha/);

  const second = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request: { ...request, model: request.model, body: request.body },
    fetchImpl: routedFetch([
      ["panel-a.local", () => new Response("down", { status: 500 })],
      ["panel-b.local", () => sseResponse(answerFrames("Beta"))],
    ]),
    io: chainIo({
      lookupCache: (key) => stored.get(key) ?? null,
    }),
  });
  assert.equal(second.kind, "route");
  if (second.kind === "route") {
    assert.match(JSON.stringify(second.request.body), /Cached alpha/);
    const panelBranch = second.branches.find(
      (branch) => branch.branch === "panel 1",
    );
    assert.equal(panelBranch?.detail, "cached answer");
  }
});

test("a failed fusion settles cache keys its branches registered", async () => {
  const a = seedExternalTarget("panel-a", "http://panel-a.local");
  const synth = seedExternalTarget("synth", "http://synth.local");
  const cache = ApiProxyPipelineNodeSchema.parse({
    id: "panel-cache",
    name: "memo",
    type: "cache",
    config: { ttlSeconds: 600, namespace: "panel" },
    ports: { next: { type: "target", id: a.id } },
  });
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fnode",
    name: "fuse",
    type: "fusion",
    config: { minQuorum: 1 },
    ports: {
      panel: [{ type: "node", id: cache.id }],
      synthesizer: { type: "target", id: synth.id },
    },
  });
  const pipeline = createApiProxyPipeline({
    name: "panel-settle",
    enabled: true,
    entry: { type: "node", id: fusion.id },
    nodes: [fusion, cache],
  });
  const fusionNode = pipeline.nodes.find((node) => node.id === fusion.id);
  assert.ok(fusionNode?.type === "fusion");

  const registered: string[] = [];
  const outcome = await executeApiProxyFusion({
    node: fusionNode,
    pipeline,
    request: fusionRequest({ model: "m", messages: [] }),
    fetchImpl: routedFetch([
      ["panel-a.local", () => new Response("down", { status: 500 })],
    ]),
    io: chainIo({
      registerOwner: (key) => {
        registered.push(key);
        registerApiProxyInFlight(key);
      },
    }),
  });

  assert.equal(outcome.kind, "error");
  assert.equal(registered.length, 1);
  assert.equal(findApiProxyInFlight(registered[0] ?? ""), null);
});

test("sub-request buffers an openai upstream into normalized text", async () => {
  const target = seedExternalTarget("panel-a");
  const result = await executeApiProxyModelSubRequest({
    targetId: target.id,
    model: fusionRequest({}).model,
    operation: chatOperation,
    body: { model: "panel-a", messages: [{ role: "user", content: "hi" }] },
    fetchImpl: openAiSseFetch([
      deltaFrame("Hello "),
      deltaFrame("world", "stop"),
      "data: [DONE]\n\n",
    ]),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.text, "Hello world");
    assert.equal(result.state.finishReason, "stop");
    assert.equal(result.translateAnthropic, false);
  }
});

test("sub-request reports a diagnostic on a missing target", async () => {
  const result = await executeApiProxyModelSubRequest({
    targetId: "does-not-exist",
    model: fusionRequest({}).model,
    operation: chatOperation,
    body: { model: "x", messages: [] },
    fetchImpl: openAiSseFetch([]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.diagnostic.message, /not found/);
  }
});

test("sub-request surfaces an upstream failure as a diagnostic", async () => {
  const target = seedExternalTarget("panel-b");
  const failingFetch = (async () =>
    new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const result = await executeApiProxyModelSubRequest({
    targetId: target.id,
    model: fusionRequest({}).model,
    operation: chatOperation,
    body: { model: "panel-b", messages: [] },
    fetchImpl: failingFetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.diagnostic.message, /failed/);
  }
});
