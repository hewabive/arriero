import { scaleApiProxyResponseTokenCount } from "@arriero/core";

import { isRecord } from "./json.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import {
  createApiProxySseTransform,
  mutateApiProxyJsonText,
  mutateApiProxySseJsonFrame,
  transformApiProxySseText,
} from "./response-codec.js";

export type ApiProxyTokenScaleResult = {
  value: unknown;
  count: number;
};

export type ApiProxyTokenScaleTextResult = {
  text: string;
  count: number;
};

const tokenKeyMarker = "_tokens";

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

  if (apiProxyOperationSpec(operation)?.countTokensResponse) {
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
  if (!input.isSse) {
    return { text: mutateApiProxyJsonText(input.text, mutate).text, count };
  }
  const text = transformApiProxySseText(input.text, {
    transform: (frame) =>
      frame.includes(tokenKeyMarker)
        ? mutateApiProxySseJsonFrame(frame, mutate).text
        : frame,
  });
  return { text, count };
}

export function createApiProxyTokenScaleStream(input: {
  factor: number;
  operation: ApiProxyProtocolOperation;
}): TransformStream<Uint8Array, Uint8Array> {
  const mutate = (value: unknown) => {
    const scaled = scaleApiProxyResponseTokens({
      value,
      factor: input.factor,
      operation: input.operation,
    });
    return { changed: scaled.count > 0, value: scaled.value };
  };
  return createApiProxySseTransform({
    transform: (frame) =>
      frame.includes(tokenKeyMarker)
        ? mutateApiProxySseJsonFrame(frame, mutate).text
        : frame,
  });
}
