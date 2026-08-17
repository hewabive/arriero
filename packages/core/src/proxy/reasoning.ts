import { z } from "zod";

import type {
  ApiProxyEditRequestOperation,
  ApiProxyJsonValue,
  ApiProxyReasoningConfig,
} from "./pipeline-nodes.js";

export const API_PROXY_REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const ApiProxyReasoningLevelSchema = z.enum(API_PROXY_REASONING_LEVELS);

export type ApiProxyReasoningLevel = z.infer<
  typeof ApiProxyReasoningLevelSchema
>;

export type ApiProxyReasoningDirective =
  | { kind: "off" }
  | { kind: "auto" }
  | { kind: "level"; level: ApiProxyReasoningLevel }
  | { kind: "budget"; tokens: number };

export const ApiProxyReasoningInterfaceSchema = z.enum([
  "template-effort",
  "budget",
  "enable-flag",
  "passthrough",
  "none",
]);

export type ApiProxyReasoningInterface = z.infer<
  typeof ApiProxyReasoningInterfaceSchema
>;

export const ApiProxyReasoningProfileSchema = z.object({
  interface: ApiProxyReasoningInterfaceSchema,
  levels: z
    .array(ApiProxyReasoningLevelSchema)
    .max(API_PROXY_REASONING_LEVELS.length)
    .default([]),
  aliases: z
    .partialRecord(ApiProxyReasoningLevelSchema, ApiProxyReasoningLevelSchema)
    .default({}),
  defaultLevel: ApiProxyReasoningLevelSchema.nullable().default(null),
  levelBudgets: z
    .partialRecord(
      ApiProxyReasoningLevelSchema,
      z.number().int().min(-1).max(10_000_000),
    )
    .default({}),
});

export type ApiProxyReasoningProfile = z.infer<
  typeof ApiProxyReasoningProfileSchema
>;

export const ApiProxyModelReasoningSchema = z.union([
  z.object({ kind: z.literal("preset"), preset: z.string().min(1).max(80) }),
  z.object({
    kind: z.literal("custom"),
    profile: ApiProxyReasoningProfileSchema,
  }),
]);

export type ApiProxyModelReasoning = z.infer<
  typeof ApiProxyModelReasoningSchema
>;

export type ApiProxyReasoningPreset = {
  id: string;
  label: string;
  profile: ApiProxyReasoningProfile;
};

function preset(
  id: string,
  label: string,
  profile: z.input<typeof ApiProxyReasoningProfileSchema>,
): ApiProxyReasoningPreset {
  return { id, label, profile: ApiProxyReasoningProfileSchema.parse(profile) };
}

export const apiProxyReasoningPresets: ApiProxyReasoningPreset[] = [
  preset("qwen3.8", "Qwen3.8 effort levels (low/medium/xhigh)", {
    interface: "template-effort",
    levels: ["low", "medium", "xhigh"],
    aliases: { high: "xhigh" },
  }),
  preset("gpt-oss", "GPT-OSS effort levels (low/medium/high)", {
    interface: "template-effort",
    levels: ["low", "medium", "high"],
  }),
  preset("thinking-budget", "Thinking token budget (llama.cpp generic)", {
    interface: "budget",
  }),
  preset("enable-flag", "Thinking on/off only (no intensity control)", {
    interface: "enable-flag",
  }),
  preset("native-passthrough", "Reasoning-capable upstream (re-emit as sent)", {
    interface: "passthrough",
  }),
  preset("non-reasoning", "Non-reasoning model (drop effort fields)", {
    interface: "none",
  }),
];

export const apiProxyPassthroughReasoningProfile: ApiProxyReasoningProfile =
  ApiProxyReasoningProfileSchema.parse({ interface: "passthrough" });

export function resolveApiProxyReasoningProfile(
  reasoning: ApiProxyModelReasoning | null | undefined,
): ApiProxyReasoningProfile | null {
  if (!reasoning) {
    return null;
  }
  if (reasoning.kind === "custom") {
    return reasoning.profile;
  }
  return (
    apiProxyReasoningPresets.find((entry) => entry.id === reasoning.preset)
      ?.profile ?? null
  );
}

export const apiProxyReasoningLevelBudgets: Record<
  ApiProxyReasoningLevel,
  number
> = {
  minimal: 256,
  low: 512,
  medium: 2048,
  high: 8192,
  xhigh: 24576,
  max: -1,
};

export function apiProxyReasoningLevelFromBudget(
  tokens: number,
): ApiProxyReasoningLevel {
  if (tokens < 0) {
    return "max";
  }
  if (tokens <= 384) {
    return "minimal";
  }
  if (tokens <= 1024) {
    return "low";
  }
  if (tokens <= 4096) {
    return "medium";
  }
  if (tokens <= 16_384) {
    return "high";
  }
  return "xhigh";
}

const levelSynonyms: Record<string, ApiProxyReasoningLevel> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  ultra: "xhigh",
  max: "max",
  maximum: "max",
};

export function normalizeApiProxyReasoningLevel(
  value: string,
): ApiProxyReasoningLevel | null {
  return levelSynonyms[value.trim().toLowerCase()] ?? null;
}

function levelRank(level: ApiProxyReasoningLevel): number {
  return API_PROXY_REASONING_LEVELS.indexOf(level);
}

export function projectApiProxyReasoningLevel(
  level: ApiProxyReasoningLevel,
  profile: ApiProxyReasoningProfile,
): ApiProxyReasoningLevel {
  const aliased = profile.aliases[level] ?? level;
  if (profile.levels.length === 0 || profile.levels.includes(aliased)) {
    return aliased;
  }
  const target = levelRank(aliased);
  let best = profile.levels[0] as ApiProxyReasoningLevel;
  let bestDistance = Math.abs(levelRank(best) - target);
  for (const candidate of profile.levels) {
    const distance = Math.abs(levelRank(candidate) - target);
    if (
      distance < bestDistance ||
      (distance === bestDistance && levelRank(candidate) > levelRank(best))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function objectField(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export type ApiProxyReasoningExtraction = {
  directive: ApiProxyReasoningDirective | null;
  fields: string[];
};

function extractOpenAi(
  record: Record<string, unknown>,
): ApiProxyReasoningExtraction {
  const fields: string[] = [];
  let directive: ApiProxyReasoningDirective | null = null;

  const consumeEffort = (raw: unknown, field: string): void => {
    if (typeof raw !== "string" || !raw.trim()) {
      return;
    }
    fields.push(`${field}=${raw}`);
    if (directive) {
      return;
    }
    const value = raw.trim().toLowerCase();
    if (value === "none" || value === "off") {
      directive = { kind: "off" };
      return;
    }
    const level = normalizeApiProxyReasoningLevel(value);
    directive = level ? { kind: "level", level } : { kind: "auto" };
  };

  const consumeBudget = (raw: unknown, field: string): void => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return;
    }
    fields.push(`${field}=${raw}`);
    if (directive) {
      return;
    }
    directive =
      raw === 0 ? { kind: "off" } : { kind: "budget", tokens: Math.trunc(raw) };
  };

  const kwargs = objectField(record.chat_template_kwargs);
  consumeEffort(record.reasoning_effort, "reasoning_effort");
  const reasoning = objectField(record.reasoning);
  if (reasoning) {
    consumeEffort(reasoning.effort, "reasoning.effort");
  }
  if (kwargs) {
    consumeEffort(
      kwargs.reasoning_effort,
      "chat_template_kwargs.reasoning_effort",
    );
  }
  consumeBudget(record.thinking_budget_tokens, "thinking_budget_tokens");
  consumeBudget(record.reasoning_budget_tokens, "reasoning_budget_tokens");
  if (kwargs && typeof kwargs.enable_thinking === "boolean") {
    fields.push(
      `chat_template_kwargs.enable_thinking=${kwargs.enable_thinking}`,
    );
    directive ??= kwargs.enable_thinking ? { kind: "auto" } : { kind: "off" };
  }
  return { directive, fields };
}

function extractAnthropic(
  record: Record<string, unknown>,
): ApiProxyReasoningExtraction {
  const fields: string[] = [];
  const thinking = objectField(record.thinking);
  const thinkingType =
    thinking && typeof thinking.type === "string" ? thinking.type : null;
  if (thinkingType) {
    fields.push(`thinking.type=${thinkingType}`);
  }
  const budgetTokens =
    thinking &&
    typeof thinking.budget_tokens === "number" &&
    Number.isFinite(thinking.budget_tokens)
      ? Math.trunc(thinking.budget_tokens)
      : null;
  if (budgetTokens !== null) {
    fields.push(`thinking.budget_tokens=${budgetTokens}`);
  }
  const outputConfig = objectField(record.output_config);
  const effortRaw =
    outputConfig && typeof outputConfig.effort === "string"
      ? outputConfig.effort
      : null;
  if (effortRaw) {
    fields.push(`output_config.effort=${effortRaw}`);
  }

  if (thinkingType === "disabled") {
    return { directive: { kind: "off" }, fields };
  }
  if (effortRaw) {
    const level = normalizeApiProxyReasoningLevel(effortRaw);
    return {
      directive: level ? { kind: "level", level } : { kind: "auto" },
      fields,
    };
  }
  if (thinkingType === "enabled") {
    return {
      directive:
        budgetTokens !== null
          ? { kind: "budget", tokens: budgetTokens }
          : { kind: "auto" },
      fields,
    };
  }
  if (thinkingType === "adaptive") {
    return { directive: { kind: "auto" }, fields };
  }
  return { directive: null, fields };
}

export function extractApiProxyReasoningDirective(
  protocol: "openai" | "anthropic",
  body: unknown,
): ApiProxyReasoningExtraction {
  const record = objectField(body);
  if (!record) {
    return { directive: null, fields: [] };
  }
  return protocol === "anthropic"
    ? extractAnthropic(record)
    : extractOpenAi(record);
}

function withoutKeys(
  record: Record<string, unknown>,
  parentKey: string,
  keys: string[],
  next: Record<string, unknown>,
): void {
  const child = objectField(next[parentKey]);
  if (!child || !keys.some((key) => key in child)) {
    return;
  }
  const rest = { ...child };
  for (const key of keys) {
    delete rest[key];
  }
  if (Object.keys(rest).length > 0) {
    next[parentKey] = rest;
  } else {
    delete next[parentKey];
  }
}

export function stripApiProxyReasoningFields(
  protocol: "openai" | "anthropic",
  body: unknown,
): unknown {
  const record = objectField(body);
  if (!record) {
    return body;
  }
  if (protocol === "anthropic") {
    const outputConfig = objectField(record.output_config);
    if (
      !("thinking" in record) &&
      !(outputConfig && "effort" in outputConfig)
    ) {
      return body;
    }
    const next = { ...record };
    delete next.thinking;
    withoutKeys(record, "output_config", ["effort"], next);
    return next;
  }
  const kwargs = objectField(record.chat_template_kwargs);
  const reasoning = objectField(record.reasoning);
  const present =
    "reasoning_effort" in record ||
    "thinking_budget_tokens" in record ||
    "reasoning_budget_tokens" in record ||
    (reasoning !== null && "effort" in reasoning) ||
    (kwargs !== null &&
      ("enable_thinking" in kwargs || "reasoning_effort" in kwargs));
  if (!present) {
    return body;
  }
  const next = { ...record };
  delete next.reasoning_effort;
  delete next.thinking_budget_tokens;
  delete next.reasoning_budget_tokens;
  withoutKeys(record, "reasoning", ["effort"], next);
  withoutKeys(
    record,
    "chat_template_kwargs",
    ["enable_thinking", "reasoning_effort"],
    next,
  );
  return next;
}

export function apiProxyReasoningDirectiveFromConfig(
  config: ApiProxyReasoningConfig,
): ApiProxyReasoningDirective | null {
  switch (config.effort) {
    case "auto":
      return null;
    case "off":
      return { kind: "off" };
    case "custom":
      return { kind: "budget", tokens: config.customBudgetTokens };
    case "max":
      return { kind: "level", level: "max" };
    default:
      return { kind: "level", level: config.effort };
  }
}

type ResolvedReasoningIntent =
  | { mode: "off" }
  | { mode: "auto" }
  | { mode: "level"; level: ApiProxyReasoningLevel }
  | { mode: "budget"; tokens: number };

function resolveIntent(
  directive: ApiProxyReasoningDirective | null,
  profile: ApiProxyReasoningProfile,
): ResolvedReasoningIntent {
  const effective = directive ?? { kind: "auto" as const };
  if (effective.kind === "off") {
    return { mode: "off" };
  }
  if (effective.kind === "auto") {
    return profile.defaultLevel
      ? { mode: "level", level: profile.defaultLevel }
      : { mode: "auto" };
  }
  if (effective.kind === "level") {
    return { mode: "level", level: effective.level };
  }
  return { mode: "budget", tokens: effective.tokens };
}

function levelBudget(
  level: ApiProxyReasoningLevel,
  profile: ApiProxyReasoningProfile,
): number {
  return profile.levelBudgets[level] ?? apiProxyReasoningLevelBudgets[level];
}

export type ApiProxyReasoningMaterialization = {
  operations: ApiProxyEditRequestOperation[];
  detail: string;
};

type FieldWrite = { path: string; value: ApiProxyJsonValue };

function operationsFor(
  family: string[],
  writes: FieldWrite[],
): ApiProxyEditRequestOperation[] {
  const written = new Set(writes.map((write) => write.path));
  const removes: ApiProxyEditRequestOperation[] = family
    .filter((path) => !written.has(path))
    .map((path) => ({ kind: "remove-field", enabled: true, path }));
  const sets: ApiProxyEditRequestOperation[] = writes.map((write) => ({
    kind: "set-field",
    enabled: true,
    path: write.path,
    value: write.value,
  }));
  return [...removes, ...sets];
}

const openAiFamily = [
  "reasoning_effort",
  "thinking_budget_tokens",
  "chat_template_kwargs.enable_thinking",
];

function materializeOpenAi(
  intent: ResolvedReasoningIntent,
  profile: ApiProxyReasoningProfile,
): ApiProxyReasoningMaterialization {
  const done = (writes: FieldWrite[], detail: string) => ({
    operations: operationsFor(openAiFamily, writes),
    detail,
  });

  if (profile.interface === "template-effort") {
    if (intent.mode === "off") {
      return done(
        [{ path: "reasoning_effort", value: "none" }],
        'off → reasoning_effort "none"',
      );
    }
    if (intent.mode === "auto") {
      return done(
        [{ path: "chat_template_kwargs.enable_thinking", value: true }],
        "auto → thinking on, template default effort",
      );
    }
    const level =
      intent.mode === "level"
        ? intent.level
        : apiProxyReasoningLevelFromBudget(intent.tokens);
    const native = projectApiProxyReasoningLevel(level, profile);
    const origin =
      intent.mode === "level"
        ? `level ${intent.level}`
        : `budget ${intent.tokens}`;
    return done(
      [{ path: "reasoning_effort", value: native }],
      `${origin} → reasoning_effort "${native}"`,
    );
  }

  if (profile.interface === "passthrough") {
    if (intent.mode === "off") {
      return done(
        [{ path: "reasoning_effort", value: "none" }],
        'off → reasoning_effort "none"',
      );
    }
    if (intent.mode === "auto") {
      return done([], "auto → upstream default");
    }
    if (intent.mode === "level") {
      return done(
        [{ path: "reasoning_effort", value: intent.level }],
        `level ${intent.level} → reasoning_effort "${intent.level}"`,
      );
    }
    return done(
      [{ path: "thinking_budget_tokens", value: intent.tokens }],
      `budget ${intent.tokens} → thinking_budget_tokens ${intent.tokens}`,
    );
  }

  if (intent.mode === "off") {
    return done(
      [{ path: "chat_template_kwargs.enable_thinking", value: false }],
      "off → enable_thinking false",
    );
  }
  const enable: FieldWrite = {
    path: "chat_template_kwargs.enable_thinking",
    value: true,
  };
  if (profile.interface === "enable-flag") {
    if (intent.mode === "budget" && intent.tokens >= 0) {
      return done(
        [enable, { path: "thinking_budget_tokens", value: intent.tokens }],
        `budget ${intent.tokens} → thinking on, ${intent.tokens} token budget`,
      );
    }
    const origin =
      intent.mode === "level" ? `level ${intent.level}` : intent.mode;
    return done([enable], `${origin} → thinking on`);
  }
  if (intent.mode === "auto") {
    return done([enable], "auto → thinking on, engine default budget");
  }
  const tokens =
    intent.mode === "level"
      ? levelBudget(intent.level, profile)
      : intent.tokens;
  const origin =
    intent.mode === "level"
      ? `level ${intent.level}`
      : `budget ${intent.tokens}`;
  if (tokens < 0) {
    return done([enable], `${origin} → thinking on, unlimited budget`);
  }
  return done(
    [enable, { path: "thinking_budget_tokens", value: tokens }],
    `${origin} → thinking on, ${tokens} token budget`,
  );
}

const anthropicFamily = ["thinking", "output_config.effort"];

function materializeAnthropic(
  intent: ResolvedReasoningIntent,
  profile: ApiProxyReasoningProfile,
): ApiProxyReasoningMaterialization {
  const done = (writes: FieldWrite[], detail: string) => ({
    operations: operationsFor(anthropicFamily, writes),
    detail,
  });
  const disabled: FieldWrite = {
    path: "thinking",
    value: { type: "disabled" },
  };
  const adaptive: FieldWrite = {
    path: "thinking",
    value: { type: "adaptive" },
  };

  if (intent.mode === "off") {
    return done([disabled], "off → thinking disabled");
  }

  if (
    profile.interface === "template-effort" ||
    profile.interface === "passthrough"
  ) {
    if (intent.mode === "auto") {
      return done([adaptive], "auto → adaptive thinking");
    }
    if (intent.mode === "budget" && profile.interface === "passthrough") {
      return done(
        [
          {
            path: "thinking",
            value:
              intent.tokens < 0
                ? { type: "adaptive" }
                : { type: "enabled", budget_tokens: intent.tokens },
          },
        ],
        `budget ${intent.tokens} → thinking enabled`,
      );
    }
    const level =
      intent.mode === "level"
        ? intent.level
        : apiProxyReasoningLevelFromBudget(intent.tokens);
    const native =
      profile.interface === "template-effort"
        ? projectApiProxyReasoningLevel(level, profile)
        : level;
    const origin =
      intent.mode === "level"
        ? `level ${intent.level}`
        : `budget ${intent.tokens}`;
    return done(
      [adaptive, { path: "output_config.effort", value: native }],
      `${origin} → output_config.effort "${native}"`,
    );
  }

  if (profile.interface === "enable-flag") {
    if (intent.mode === "budget" && intent.tokens >= 0) {
      return done(
        [
          {
            path: "thinking",
            value: { type: "enabled", budget_tokens: intent.tokens },
          },
        ],
        `budget ${intent.tokens} → thinking enabled`,
      );
    }
    const origin =
      intent.mode === "level" ? `level ${intent.level}` : intent.mode;
    return done([adaptive], `${origin} → adaptive thinking`);
  }

  if (intent.mode === "auto") {
    return done([adaptive], "auto → adaptive thinking");
  }
  const tokens =
    intent.mode === "level"
      ? levelBudget(intent.level, profile)
      : intent.tokens;
  const origin =
    intent.mode === "level"
      ? `level ${intent.level}`
      : `budget ${intent.tokens}`;
  if (tokens < 0) {
    return done([adaptive], `${origin} → adaptive thinking`);
  }
  return done(
    [{ path: "thinking", value: { type: "enabled", budget_tokens: tokens } }],
    `${origin} → thinking enabled, ${tokens} token budget`,
  );
}

export function apiProxyReasoningDirectiveOperations(
  directive: ApiProxyReasoningDirective | null,
  profile: ApiProxyReasoningProfile,
  protocol: "openai" | "anthropic",
): ApiProxyReasoningMaterialization {
  if (profile.interface === "none") {
    return { operations: [], detail: "non-reasoning model, effort dropped" };
  }
  const intent = resolveIntent(directive, profile);
  return protocol === "anthropic"
    ? materializeAnthropic(intent, profile)
    : materializeOpenAi(intent, profile);
}

export function apiProxyReasoningExtractionDetail(
  extraction: ApiProxyReasoningExtraction,
): string {
  return extraction.fields.length > 0
    ? extraction.fields.join(", ")
    : "no reasoning fields";
}
