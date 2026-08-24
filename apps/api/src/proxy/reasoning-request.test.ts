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
  type ApiProxyReasoningOverride,
  type ApiProxyReasoningProfile,
  type GgufModel,
} from "@arriero/core";

import { config } from "../config.js";
import { createInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import { saveCachedModel } from "../models/cache-repository.js";
import { emptyMetadata } from "../models/scanner.js";
import { createApiEndpoint } from "./endpoints.js";
import {
  instanceReasoningTemplateIssue,
  reasoningProfileFromTemplate,
} from "../instances/reasoning-profile.js";
import {
  applyApiProxyReasoningMapping,
  resolveApiProxyUpstreamReasoningProfile,
} from "./reasoning-request.js";

const { uniqueName, seedBinaryRef, binaryRefId } =
  instanceTestFixture("reasoning");

const qwen38 = { kind: "preset", preset: "qwen3.8" } as const;

function qwen38Profile(): ApiProxyReasoningProfile {
  const profile = resolveApiProxyReasoningProfile(qwen38);
  assert.ok(profile);
  return profile;
}

function seedLlamaInstance(input: {
  modelPath: string | null;
  cachedReasoning?: GgufModel["metadata"]["chatTemplateReasoning"];
  reasoning?: ApiProxyReasoningOverride;
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
            hasChatTemplate: true,
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
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
  });
  return name;
}

function seedEndpoint(reasoning: ApiProxyReasoningOverride | null): string {
  return createApiEndpoint({
    name: uniqueName("endpoint"),
    enabled: true,
    baseUrl: "https://upstream.test/v1",
    profile: "openai",
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    modelFilter: null,
    streamTerminal: null,
    reasoning,
  }).id;
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
    strict: true,
  });
  assert.deepEqual(profile, {
    interface: "template-effort",
    strict: true,
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
      strict: false,
    }).levels,
    [],
  );
});

test("tolerant ladders keep sub-ladder levels and project the rest", () => {
  const profile = reasoningProfileFromTemplate({
    usesReasoningEffort: true,
    usesEnableThinking: true,
    levels: ["high", "max"],
    aliases: null,
    strict: false,
  });
  assert.equal(projectApiProxyReasoningLevel("minimal", profile), "minimal");
  assert.equal(projectApiProxyReasoningLevel("low", profile), "low");
  assert.equal(projectApiProxyReasoningLevel("medium", profile), "medium");
  assert.equal(projectApiProxyReasoningLevel("high", profile), "high");
  assert.equal(projectApiProxyReasoningLevel("xhigh", profile), "max");
  assert.equal(projectApiProxyReasoningLevel("max", profile), "max");
});

test("instance override wins over autodetect and clamps onto its ladder", () => {
  const instanceId = seedLlamaInstance({
    modelPath: "override-wins.gguf",
    cachedReasoning: {
      usesReasoningEffort: true,
      usesEnableThinking: true,
      levels: ["high", "max"],
      aliases: null,
      strict: false,
    },
    reasoning: qwen38,
  });
  const minimal = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "minimal" },
    instanceId,
    endpointId: null,
  });
  assert.deepEqual(minimal.body, { model: "m", reasoning_effort: "low" });
  assert.equal(
    minimal.traceStep?.nodeName,
    "reasoning profile (instance override)",
  );

  const claudeCode = applyApiProxyReasoningMapping({
    protocol: "anthropic",
    body: {
      model: "m",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    },
    instanceId,
    endpointId: null,
  });
  assert.deepEqual(claudeCode.body, {
    model: "m",
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
  });
});

test("mapping is identity without a profile or without a directive", () => {
  const noUpstream = { model: "m", reasoning_effort: "medium" };
  assert.equal(
    applyApiProxyReasoningMapping({
      protocol: "openai",
      body: noUpstream,
      instanceId: null,
      endpointId: null,
    }).body,
    noUpstream,
  );
  const instanceId = seedLlamaInstance({
    modelPath: null,
    reasoning: qwen38,
  });
  const noDirective = { model: "m", messages: [] };
  assert.equal(
    applyApiProxyReasoningMapping({
      protocol: "openai",
      body: noDirective,
      instanceId,
      endpointId: null,
    }).body,
    noDirective,
  );
});

test("a llama instance without template detection defaults to the budget interface", () => {
  const instanceId = seedLlamaInstance({ modelPath: null });
  const resolved = resolveApiProxyUpstreamReasoningProfile({
    instanceId,
    endpointId: null,
  });
  assert.equal(resolved?.profile.interface, "budget");
  assert.equal(resolved?.source, "engine default");

  const mapped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    instanceId,
    endpointId: null,
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
      strict: true,
    },
  });
  const mapped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    instanceId,
    endpointId: null,
  });
  assert.deepEqual(mapped.body, { model: "m", reasoning_effort: "xhigh" });
  assert.equal(mapped.traceStep?.nodeName, "reasoning profile (template)");
  assert.equal(
    mapped.traceStep?.detail,
    'reasoning_effort=high → level high → reasoning_effort "xhigh"',
  );
  assert.equal(instanceReasoningTemplateIssue(instanceId), null);
});

test("a tolerant template instance passes sub-ladder levels unchanged", () => {
  const instanceId = seedLlamaInstance({
    modelPath: "deepseek-v4.gguf",
    cachedReasoning: {
      usesReasoningEffort: true,
      usesEnableThinking: true,
      levels: ["high", "max"],
      aliases: null,
      strict: false,
    },
  });
  const low = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "low" },
    instanceId,
    endpointId: null,
  });
  assert.deepEqual(low.body, { model: "m", reasoning_effort: "low" });
  const xhigh = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "xhigh" },
    instanceId,
    endpointId: null,
  });
  assert.deepEqual(xhigh.body, { model: "m", reasoning_effort: "max" });
  assert.equal(instanceReasoningTemplateIssue(instanceId), null);
});

test("an unrecognized effort template surfaces as a reasoning-template issue", () => {
  const strictInstance = seedLlamaInstance({
    modelPath: "strict-unknown.gguf",
    cachedReasoning: {
      usesReasoningEffort: true,
      usesEnableThinking: false,
      levels: null,
      aliases: null,
      strict: true,
    },
  });
  assert.equal(instanceReasoningTemplateIssue(strictInstance), "strict");

  const tolerantInstance = seedLlamaInstance({
    modelPath: "tolerant-unknown.gguf",
    cachedReasoning: {
      usesReasoningEffort: true,
      usesEnableThinking: true,
      levels: null,
      aliases: null,
      strict: false,
    },
  });
  assert.equal(instanceReasoningTemplateIssue(tolerantInstance), "tolerant");

  const budgetInstance = seedLlamaInstance({ modelPath: null });
  assert.equal(instanceReasoningTemplateIssue(budgetInstance), null);
});

test("an instance override clears the reasoning-template issue", () => {
  const instanceId = seedLlamaInstance({
    modelPath: "overridden-unknown.gguf",
    cachedReasoning: {
      usesReasoningEffort: true,
      usesEnableThinking: false,
      levels: null,
      aliases: null,
      strict: true,
    },
    reasoning: qwen38,
  });
  assert.equal(instanceReasoningTemplateIssue(instanceId), null);
  const resolved = resolveApiProxyUpstreamReasoningProfile({
    instanceId,
    endpointId: null,
  });
  assert.equal(resolved?.source, "instance override");
});

test("non-reasoning override strips effort fields and passthrough is identity", () => {
  const strippingInstance = seedLlamaInstance({
    modelPath: null,
    reasoning: { kind: "preset", preset: "non-reasoning" },
  });
  const stripped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    instanceId: strippingInstance,
    endpointId: null,
  });
  assert.deepEqual(stripped.body, { model: "m" });

  const passthroughInstance = seedLlamaInstance({
    modelPath: null,
    reasoning: { kind: "preset", preset: "native-passthrough" },
  });
  const passthrough = { model: "m", reasoning_effort: "high" };
  assert.equal(
    applyApiProxyReasoningMapping({
      protocol: "openai",
      body: passthrough,
      instanceId: passthroughInstance,
      endpointId: null,
    }).body,
    passthrough,
  );
});

test("custom profiles honor their default level when the client sent nothing", () => {
  const instanceId = seedLlamaInstance({
    modelPath: null,
    reasoning: {
      kind: "custom",
      profile: {
        interface: "template-effort",
        strict: true,
        levels: ["low", "high"],
        aliases: {},
        defaultLevel: "high",
        levelBudgets: {},
      },
    },
  });
  const defaulted = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m" },
    instanceId,
    endpointId: null,
  });
  assert.deepEqual(defaulted.body, { model: "m", reasoning_effort: "high" });
});

test("an endpoint override maps requests routed to an external provider", () => {
  const endpointId = seedEndpoint({ kind: "preset", preset: "non-reasoning" });
  const resolved = resolveApiProxyUpstreamReasoningProfile({
    instanceId: null,
    endpointId,
  });
  assert.equal(resolved?.source, "endpoint override");
  assert.equal(resolved?.profile.interface, "none");

  const mapped = applyApiProxyReasoningMapping({
    protocol: "openai",
    body: { model: "m", reasoning_effort: "high" },
    instanceId: null,
    endpointId,
  });
  assert.deepEqual(mapped.body, { model: "m" });

  const plainEndpoint = seedEndpoint(null);
  assert.equal(
    resolveApiProxyUpstreamReasoningProfile({
      instanceId: null,
      endpointId: plainEndpoint,
    }),
    null,
  );
});
