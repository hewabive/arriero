import assert from "node:assert/strict";
import test from "node:test";

import type {
  Instance,
  InstanceKind,
  WorkloadDatasetManifest,
  WorkloadDatasetRecord,
  WorkloadDatasetSegment,
} from "@arriero/core";

import {
  checkDatasetContextFit,
  probeInstanceContextTokens,
} from "./context-check.js";

function instance(kind: InstanceKind): Instance {
  return { name: `${kind}-context`, kind, args: {} } as unknown as Instance;
}

function engine(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    calls.push(`${parsed.pathname}${parsed.search}`);
    const route = routes[parsed.pathname];
    return route ? route() : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("llama.cpp reports the per-slot context from /props", async () => {
  const { fetchImpl, calls } = engine({
    "/props": () =>
      Response.json({ default_generation_settings: { n_ctx: 16384 } }),
  });
  const tokens = await probeInstanceContextTokens({
    instance: instance("llama-server"),
    baseUrl: "http://engine.local",
    model: "qwen",
    fetchImpl,
    signal: new AbortController().signal,
  });
  assert.equal(tokens, 16384);
  assert.deepEqual(calls, ["/props?model=qwen&autoload=false"]);
});

test("vLLM and SGLang report max_model_len of the served model", async () => {
  const { fetchImpl } = engine({
    "/v1/models": () =>
      Response.json({
        data: [
          { id: "other", max_model_len: 4096 },
          { id: "served", max_model_len: 131072 },
        ],
      }),
  });
  const probe = (model: string | null) =>
    probeInstanceContextTokens({
      instance: instance("vllm"),
      baseUrl: "http://engine.local",
      model,
      fetchImpl,
      signal: new AbortController().signal,
    });
  assert.equal(await probe("served"), 131072);
  assert.equal(await probe(null), 4096);
  const missing = engine({});
  assert.equal(
    await probeInstanceContextTokens({
      instance: instance("sglang"),
      baseUrl: "http://engine.local",
      model: "served",
      fetchImpl: missing.fetchImpl,
      signal: new AbortController().signal,
    }),
    null,
  );
});

function record(
  traceId: string,
  promptTokens: number | null,
  messages: number,
): WorkloadDatasetRecord {
  return {
    traceId,
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    offsetMs: 0,
    thinkTimeMs: null,
    durationMs: 10,
    outcome: "success",
    targetName: null,
    promptTokens,
    cacheReadTokens: null,
    completionTokens: null,
    ttftMs: null,
    body: {
      fields: {},
      messages: Array.from({ length: messages }, (_, index) =>
        String(index).padStart(64, "0"),
      ),
      tools: null,
      system: null,
    },
  };
}

function manifest(segments: WorkloadDatasetSegment[]): WorkloadDatasetManifest {
  return {
    id: "0".repeat(64),
    meta: {
      name: "fit",
      description: "",
      createdAt: "2026-09-20T10:00:00.000Z",
      arrieroVersion: null,
      population: null,
      profile: null,
      populationProfile: null,
      warnings: [],
    },
    content: {
      formatVersion: 1,
      normalizationVersion: 1,
      selection: {
        windows: [
          { from: "2026-09-20T10:00:00.000Z", to: "2026-09-20T10:10:00.000Z" },
        ],
        sourceId: null,
        sourceName: null,
        modelId: null,
        targetId: null,
        targetName: null,
      },
      segments,
    },
  };
}

function segment(
  sessionId: string,
  records: WorkloadDatasetRecord[],
  priming: WorkloadDatasetRecord | null = null,
): WorkloadDatasetSegment {
  return {
    sessionId,
    windowIndex: 0,
    sourceName: null,
    modelId: "m",
    priming,
    primingEndedAt: null,
    records,
  };
}

test("the largest request of each segment, priming included, must fit with the output ceiling", async () => {
  const counted: string[] = [];
  const report = await checkDatasetContextFit({
    manifest: manifest([
      segment("small", [record("s1", 100, 1), record("s2", 300, 3)]),
      segment("primed", [record("p1", 200, 3)], record("p0", 900, 1)),
      segment("unknown", [record("u1", null, 1), record("u2", null, 5)]),
    ]),
    contextTokens: 1000,
    outputCeiling: 200,
    countTokens: async (entry) => {
      counted.push(entry.traceId);
      return entry.traceId === "u2" ? null : (entry.promptTokens ?? 0) + 1;
    },
  });
  assert.deepEqual(counted, ["s2", "p0", "u2"]);
  assert.deepEqual(
    report.segments.map((entry) => [entry.sessionId, entry.fits]),
    [
      ["small", true],
      ["primed", false],
      ["unknown", null],
    ],
  );
  assert.deepEqual(report.warnings, [
    "1 of 3 segments could not be counted with the instance tokenizer",
  ]);
});

test("an unknown context size leaves every segment unjudged", async () => {
  const report = await checkDatasetContextFit({
    manifest: manifest([segment("only", [record("o1", 10, 1)])]),
    contextTokens: null,
    outputCeiling: 100,
    countTokens: async () => 10,
  });
  assert.equal(report.segments[0]?.fits, null);
  assert.deepEqual(report.warnings, [
    "the instance does not report its context size",
  ]);
});
