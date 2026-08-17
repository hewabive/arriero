import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  apiProxyReasoningLevelFromBudget,
  extractApiProxyReasoningDirective,
  projectApiProxyReasoningLevel,
  resolveApiProxyReasoningProfile,
  stripApiProxyReasoningFields,
  type ApiProxyModelReasoning,
  type ApiProxyModelRecord,
  type ApiProxyReasoningProfile,
  type GgufModel,
} from "@arriero/core";

import { config } from "../config.js";
import { createInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import { saveCachedModel } from "../models/cache-repository.js";
import {
  applyApiProxyReasoningMapping,
  reasoningProfileFromTemplate,
  resolveApiProxyUpstreamReasoningProfile,
} from "./reasoning-request.js";

const { uniqueName, seedBinaryRef, binaryRefId } =
  instanceTestFixture("reasoning");

function model(reasoning: ApiProxyModelReasoning | null): ApiProxyModelRecord {
  return {
    id: "model-a",
    modelId: "public-model",
    visible: true,
    enabled: true,
    ownedBy: "arriero",
    targetId: null,
    routeTo: null,
    description: null,
    blockedMessage: "",
    reasoning,
  };
}

const qwen38 = { kind: "preset", preset: "qwen3.8" } as const;

function qwen38Profile(): ApiProxyReasoningProfile {
  const profile = resolveApiProxyReasoningProfile(qwen38);
  assert.ok(profile);
  return profile;
}

function seedLlamaInstance(input: {
  modelPath: string | null;
  cachedReasoning?: GgufModel["metadata"]["chatTemplateReasoning"];
}): string {
  const name = uniqueName("inst");
  const dir = join(config.modelsDir, "reasoning-test");
  mkdirSync(dir, { recursive: true });
  let args: Record<string, string> = {};
  if (input.modelPath) {
    const path = join(dir, input.modelPath);
    writeFileSync(path, "");
    args = { "--model": path };
    if (input.cachedReasoning !== undefined) {
      saveCachedModel(
        {
          name: input.modelPath,
          path,
          directory: dir,
          sizeBytes: 0,
          modifiedAt: "2026-08-17T00:00:00.000Z",
          isMmproj: false,
          mmprojPaths: [],
          metadata: {
            ...emptyMetadata(),
            chatTemplateReasoning: input.cachedReasoning,
          },
        },
        null,
      );
    }
  }
  if (!binaryRefId()) {
    seedBinaryRef();
  }
  createInstance({
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPathRefId: binaryRefId(),
    args,
    env: {},
    memory: [],
  });
  return name;
}

function emptyMetadata(): GgufModel["metadata"] {
  return {
    name: null,
    architecture: null,
    modelType: null,
    poolingType: null,
    causalAttention: null,
    hasClassifierHead: null,
    quantization: null,
    quantizationVersion: null,
    sizeLabel: null,
    basename: null,
    finetune: null,
    license: null,
    licenseLink: null,
    repoUrl: null,
    version: null,
    quantizedBy: null,
    tags: [],
    baseModels: [],
    parameterCount: null,
    contextLength: null,
    embeddingLength: null,
    blockCount: null,
    leadingDenseBlockCount: null,
    feedForwardLength: null,
    expertCount: null,
    expertUsedCount: null,
    expertSharedCount: null,
    expertFeedForwardLength: null,
    headCount: null,
    headCountKv: null,
    attentionKeyLength: null,
    attentionValueLength: null,
    attentionKeyLengthMla: null,
    attentionValueLengthMla: null,
    slidingWindow: null,
    slidingWindowPattern: null,
    sharedKvLayers: null,
    nextnPredictLayers: null,
    shortConvCacheLength: null,
    ssmConvKernel: null,
    ssmGroupCount: null,
    ssmInnerSize: null,
    ssmStateSize: null,
    wkvHeadSize: null,
    tokenShiftCount: null,
    kdaHeadDim: null,
    ropeFreqBase: null,
    ropeScalingType: null,
    ropeScalingFactor: null,
    ropeScalingOrigCtxLen: null,
    tokenizerModel: null,
    tokenizerPre: null,
    addBosToken: null,
    addEosToken: null,
    hasChatTemplate: true,
    chatTemplateReasoning: null,
    vocabularySize: null,
    samplingTemp: null,
    samplingTopK: null,
    samplingTopP: null,
    imatrixDataset: null,
    imatrixEntries: null,
    imatrixChunks: null,
  };
}

test("openai extraction reads reasoning_effort and off spellings", () => {
  assert.deepEqual(
    extractApiProxyReasoningDirective("openai", { reasoning_effort: "high" })
      .directive,
    { kind: "level", level: "high" },
  );
  assert.deepEqual(
    extractApiProxyReasoningDirective("openai", { reasoning_effort: "none" })
      .directive,
    { kind: "off" },
  );
  assert.deepEqual(
    extractApiProxyReasoningDirective("openai", {
      thinking_budget_tokens: 4096,
    }).directive,
    { kind: "budget", tokens: 4096 },
  );
  assert.equal(
    extractApiProxyReasoningDirective("openai", { messages: [] }).directive,
    null,
  );
});

test("anthropic extraction reads the Claude Code request shape", () => {
  const claudeCode = extractApiProxyReasoningDirective("anthropic", {
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  });
  assert.deepEqual(claudeCode.directive, { kind: "level", level: "medium" });
  assert.deepEqual(claudeCode.fields, [
    "thinking.type=adaptive",
    "output_config.effort=medium",
  ]);
  assert.deepEqual(
    extractApiProxyReasoningDirective("anthropic", {
      thinking: { type: "enabled", budget_tokens: 10_000 },
    }).directive,
    { kind: "budget", tokens: 10_000 },
  );
});

test("level projection clamps onto the profile ladder with aliases first", () => {
  const profile = qwen38Profile();
  assert.equal(projectApiProxyReasoningLevel("high", profile), "xhigh");
  assert.equal(projectApiProxyReasoningLevel("minimal", profile), "low");
  assert.equal(projectApiProxyReasoningLevel("max", profile), "xhigh");
  assert.equal(apiProxyReasoningLevelFromBudget(10_000), "high");
});

test("strip removes reasoning fields and keeps unrelated keys", () => {
  assert.deepEqual(
    stripApiProxyReasoningFields("openai", {
      model: "m",
      reasoning_effort: "high",
      thinking_budget_tokens: 2048,
      chat_template_kwargs: { enable_thinking: true, foo: "bar" },
    }),
    { model: "m", chat_template_kwargs: { foo: "bar" } },
  );
  const untouched = { model: "m", messages: [] };
  assert.equal(stripApiProxyReasoningFields("openai", untouched), untouched);
});

test("template detection maps to a normalized template-effort profile", () => {
  const profile = reasoningProfileFromTemplate({
    usesReasoningEffort: true,
    usesEnableThinking: true,
    levels: ["xhigh", "medium", "low", "banana"],
    aliases: { high: "xhigh", weird: "banana" },
  });
  assert.deepEqual(profile, {
    interface: "template-effort",
    levels: ["low", "medium", "xhigh"],
    aliases: { high: "xhigh" },
    defaultLevel: null,
    levelBudgets: {},
  });
  assert.deepEqual(
    reasoningProfileFromTemplate({
      usesReasoningEffort: true,
      usesEnableThinking: false,
      levels: ["fast"],
      aliases: null,
    }).levels,
    [],
  );
});

test("model override wins and clamps onto the Qwen3.8 ladder", () => {
  const minimal = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "minimal" },
    model: model(qwen38),
    instanceId: null,
  });
  assert.deepEqual(minimal.body, { model: "m", reasoning_effort: "low" });
  assert.equal(
    minimal.traceStep?.nodeName,
    "reasoning profile (model override)",
  );

  const claudeCode = applyApiProxyReasoningMapping({
    protocol: "anthropic",
    body: {
      model: "m",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    },
    model: model(qwen38),
    instanceId: null,
  });
  assert.deepEqual(claudeCode.body, {
    model: "m",
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
  });
});

test("mapping is identity without a profile or without a directive", () => {
  const noProfile = { model: "m", reasoning_effort: "medium" };
  assert.equal(
    applyApiProxyReasoningMapping({
      protocol: "openai",
      body: noProfile,
      model: model(null),
      instanceId: null,
    }).body,
    noProfile,
  );
  const noDirective = { model: "m", messages: [] };
  assert.equal(
    applyApiProxyReasoningMapping({
      protocol: "openai",
      body: noDirective,
      model: model(qwen38),
      instanceId: null,
    }).body,
    noDirective,
  );
});

test("a llama instance without template detection defaults to the budget interface", () => {
  const instanceId = seedLlamaInstance({ modelPath: null });
  const resolved = resolveApiProxyUpstreamReasoningProfile({
    model: model(null),
    instanceId,
  });
  assert.equal(resolved?.profile.interface, "budget");
  assert.equal(resolved?.source, "engine default");

  const mapped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    model: model(null),
    instanceId,
  });
  assert.deepEqual(mapped.body, {
    model: "m",
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 8192,
  });
});

test("a llama instance with a detected effort template maps onto its ladder", () => {
  const instanceId = seedLlamaInstance({
    modelPath: "qwen38.gguf",
    cachedReasoning: {
      usesReasoningEffort: true,
      usesEnableThinking: true,
      levels: ["xhigh", "medium", "low"],
      aliases: { high: "xhigh" },
    },
  });
  const mapped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    model: model(null),
    instanceId,
  });
  assert.deepEqual(mapped.body, { model: "m", reasoning_effort: "xhigh" });
  assert.equal(mapped.traceStep?.nodeName, "reasoning profile (template)");
  assert.equal(
    mapped.traceStep?.detail,
    'reasoning_effort=high → level high → reasoning_effort "xhigh"',
  );
});

test("non-reasoning override strips effort fields and passthrough is identity", () => {
  const stripped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    model: model({ kind: "preset", preset: "non-reasoning" }),
    instanceId: null,
  });
  assert.deepEqual(stripped.body, { model: "m" });

  const passthrough = { model: "m", reasoning_effort: "high" };
  assert.equal(
    applyApiProxyReasoningMapping({
      protocol: "openai",
      body: passthrough,
      model: model({ kind: "preset", preset: "native-passthrough" }),
      instanceId: null,
    }).body,
    passthrough,
  );
});

test("custom profiles honor their default level when the client sent nothing", () => {
  const custom: ApiProxyModelReasoning = {
    kind: "custom",
    profile: {
      interface: "template-effort",
      levels: ["low", "high"],
      aliases: {},
      defaultLevel: "high",
      levelBudgets: {},
    },
  };
  const defaulted = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m" },
    model: model(custom),
    instanceId: null,
  });
  assert.deepEqual(defaulted.body, { model: "m", reasoning_effort: "high" });
});
