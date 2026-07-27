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
} from "./fusion.js";
import {
  bodyRequestsStreaming,
  type ApiProxyProtocolModelRequest,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyTarget,
} from "./repository.js";

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

test("sub-request buffers an openai upstream into normalized text", async () => {
  const target = seedExternalTarget("panel-a");
  const result = await executeApiProxyModelSubRequest({
    targetId: target.id,
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
    operation: chatOperation,
    body: { model: "panel-b", messages: [] },
    fetchImpl: failingFetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.diagnostic.message, /failed/);
  }
});
