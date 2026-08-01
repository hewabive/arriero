import type { ApiProxyProtocolOperation } from "./protocol.js";
import {
  createApiProxySseTransform,
  mutateApiProxyJsonText,
  mutateApiProxySseJsonFrame,
  mutateApiProxySseJsonText,
} from "./response-codec.js";

type JsonRecord = Record<string, unknown>;

export type ApiProxyTokenScaleResult = {
  value: unknown;
  count: number;
};

export type ApiProxyTokenScaleTextResult = {
  text: string;
  count: number;
};

const requestLimitKeys = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "max_new_tokens",
  "n_predict",
  "num_predict",
  "thinking_budget_tokens",
  "reasoning_budget_tokens",
] as const;

const nestedBudgetKeys = ["budget_tokens", "max_tokens"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, value));
}

export function scaleApiProxyRequestTokenCount(
  value: number,
  factor: number,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    return value;
  }
  return boundedInteger(Math.floor(value / factor));
}

export function scaleApiProxyResponseTokenCount(
  value: number,
  factor: number,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    return value;
  }
  return boundedInteger(Math.ceil(value * factor));
}

export function scaleApiProxyRequestTokens(
  value: unknown,
  factor: number,
): ApiProxyTokenScaleResult {
  if (!isRecord(value) || factor === 1) {
    return { value, count: 0 };
  }
  let next: JsonRecord | null = null;
  let count = 0;
  const write = (owner: JsonRecord, key: string, scaled: number) => {
    if (next === null) {
      next = { ...value };
    }
    if (owner === value) {
      next[key] = scaled;
    }
  };

  for (const key of requestLimitKeys) {
    const current = value[key];
    if (typeof current !== "number") {
      continue;
    }
    const scaled = scaleApiProxyRequestTokenCount(current, factor);
    if (scaled !== current) {
      write(value, key, scaled);
      count += 1;
    }
  }

  for (const ownerKey of ["thinking", "reasoning"] as const) {
    const nested = value[ownerKey];
    if (!isRecord(nested)) {
      continue;
    }
    let nestedNext: JsonRecord | null = null;
    for (const key of nestedBudgetKeys) {
      const current = nested[key];
      if (typeof current !== "number") {
        continue;
      }
      const scaled = scaleApiProxyRequestTokenCount(current, factor);
      if (scaled === current) {
        continue;
      }
      nestedNext ??= { ...nested };
      nestedNext[key] = scaled;
      count += 1;
    }
    if (nestedNext) {
      next ??= { ...value };
      next[ownerKey] = nestedNext;
    }
  }

  return { value: next ?? value, count };
}

function scaleUsageTree(value: unknown, factor: number): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) => count + scaleUsageTree(item, factor),
      0,
    );
  }
  if (!isRecord(value)) {
    return 0;
  }
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (key === "total_tokens") {
      continue;
    }
    if (typeof item === "number" && key.endsWith("_tokens")) {
      const scaled = scaleApiProxyResponseTokenCount(item, factor);
      if (scaled !== item) {
        value[key] = scaled;
        count += 1;
      }
      continue;
    }
    count += scaleUsageTree(item, factor);
  }
  if (typeof value.total_tokens === "number") {
    const original = value.total_tokens;
    const prompt = value.prompt_tokens;
    const completion = value.completion_tokens;
    const input = value.input_tokens;
    const output = value.output_tokens;
    const scaled =
      typeof prompt === "number" && typeof completion === "number"
        ? prompt + completion
        : typeof input === "number" && typeof output === "number"
          ? input + output
          : scaleApiProxyResponseTokenCount(original, factor);
    if (scaled !== original) {
      value.total_tokens = scaled;
      count += 1;
    }
  }
  return count;
}

function scaleResponseObject(
  value: unknown,
  factor: number,
  operation: ApiProxyProtocolOperation,
): number {
  if (!isRecord(value) || factor === 1) {
    return 0;
  }
  let count = 0;
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) {
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key === "usage") {
        count += scaleUsageTree(item, factor);
      } else {
        visit(item);
      }
      if (key === "max_output_tokens" && typeof current[key] === "number") {
        const original = current[key] as number;
        const scaled = scaleApiProxyResponseTokenCount(original, factor);
        if (scaled !== original) {
          current[key] = scaled;
          count += 1;
        }
      }
    }
  };
  visit(value);

  if (operation.endpoint === "messages.count_tokens") {
    const inputTokens = value.input_tokens;
    if (typeof inputTokens === "number") {
      const scaled = scaleApiProxyResponseTokenCount(inputTokens, factor);
      if (scaled !== inputTokens) {
        value.input_tokens = scaled;
        count += 1;
      }
    }
  }
  return count;
}

export function scaleApiProxyResponseTokens(input: {
  value: unknown;
  factor: number;
  operation: ApiProxyProtocolOperation;
}): ApiProxyTokenScaleResult {
  const count = scaleResponseObject(input.value, input.factor, input.operation);
  return { value: input.value, count };
}

export function scaleApiProxyResponseTokenText(input: {
  text: string;
  factor: number;
  operation: ApiProxyProtocolOperation;
  isSse: boolean;
}): ApiProxyTokenScaleTextResult {
  let count = 0;
  const mutate = (value: unknown) => {
    const scaled = scaleApiProxyResponseTokens({
      value,
      factor: input.factor,
      operation: input.operation,
    });
    count += scaled.count;
    return { changed: scaled.count > 0, value: scaled.value };
  };
  const mutation = input.isSse
    ? mutateApiProxySseJsonText(input.text, mutate)
    : mutateApiProxyJsonText(input.text, mutate);
  return { text: mutation.text, count };
}

export function createApiProxyTokenScaleStream(input: {
  factor: number;
  operation: ApiProxyProtocolOperation;
  onScale?: ((count: number) => void) | undefined;
}): TransformStream<Uint8Array, Uint8Array> {
  return createApiProxySseTransform({
    transform: (frame) => {
      const mutation = mutateApiProxySseJsonFrame(frame, (value) => {
        const scaled = scaleApiProxyResponseTokens({
          value,
          factor: input.factor,
          operation: input.operation,
        });
        if (scaled.count > 0) {
          input.onScale?.(scaled.count);
        }
        return { changed: scaled.count > 0, value: scaled.value };
      });
      return mutation.text;
    },
  });
}
