import type { ApiProxyEditRequestOperation } from "../index.js";

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

const nestedBudgetOwnerKeys = ["thinking", "reasoning"] as const;
const nestedBudgetKeys = ["budget_tokens", "max_tokens"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

export function apiProxyTokenScaleEditOperations(
  factor: number,
  body: unknown,
): ApiProxyEditRequestOperation[] {
  const record = asRecord(body);
  if (!record || factor === 1) {
    return [];
  }
  const operations: ApiProxyEditRequestOperation[] = [];
  const scaleField = (path: string, current: unknown) => {
    if (typeof current !== "number") {
      return;
    }
    const scaled = scaleApiProxyRequestTokenCount(current, factor);
    if (scaled !== current) {
      operations.push({
        kind: "set-field",
        enabled: true,
        path,
        value: scaled,
      });
    }
  };
  for (const key of requestLimitKeys) {
    scaleField(key, record[key]);
  }
  for (const ownerKey of nestedBudgetOwnerKeys) {
    const nested = asRecord(record[ownerKey]);
    if (!nested) {
      continue;
    }
    for (const key of nestedBudgetKeys) {
      scaleField(`${ownerKey}.${key}`, nested[key]);
    }
  }
  return operations;
}
