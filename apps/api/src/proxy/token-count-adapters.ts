import type { EngineTokenCountId } from "@arriero/core";

import { asObject } from "./json.js";

export type ApiProxyTokenMeasurement =
  | { tokens: number }
  | { minimumTokens: number };

type TokenCountAdapter = {
  name: string;
  path: string;
  llamaReadiness: boolean;
  prepareBody: (body: Record<string, unknown>) => Record<string, unknown>;
  read: (body: unknown, status: number) => ApiProxyTokenMeasurement | null;
  responseField: string;
  errorStatus: number | null;
};

function isTokenNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonStreamingBody(body: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...body, stream: false };
  delete result.stream_options;
  return result;
}

function vllmOverflow(body: unknown): ApiProxyTokenMeasurement | null {
  const error = asObject(asObject(body)?.error);
  if (
    error?.type !== "BadRequestError" ||
    error.param !== "input_tokens" ||
    error.code !== 400 ||
    typeof error.message !== "string"
  )
    return null;
  const match =
    /^This model's maximum context length is (\d+) tokens\. However, you requested (\d+) output tokens and your prompt contains (at least )?(\d+) input tokens, for a total of (at least )?(\d+) tokens\. Please reduce the length of the input prompt or the number of requested output tokens\.(?: \(parameter=input_tokens, value=(\d+)\))?$/.exec(
      error.message,
    );
  if (!match) return null;
  const context = Number(match[1]);
  const output = Number(match[2]);
  const minimumTokens = Number(match[4]);
  const total = Number(match[6]);
  if (
    ![context, output, minimumTokens, total].every(isTokenNumber) ||
    context === 0 ||
    minimumTokens === 0 ||
    output > context ||
    total !== output + minimumTokens ||
    total <= context ||
    match[3] !== match[5] ||
    (match[7] !== undefined && Number(match[7]) !== minimumTokens)
  )
    return null;
  return { minimumTokens };
}

export const tokenCountAdapters: Record<
  Exclude<EngineTokenCountId, "none">,
  TokenCountAdapter
> = {
  llama: {
    name: "llama.cpp",
    path: "/v1/chat/completions/input_tokens",
    llamaReadiness: true,
    prepareBody: (body) => body,
    responseField: "input_tokens",
    errorStatus: null,
    read: (body, status) => {
      const tokens = asObject(body)?.input_tokens;
      return status === 200 && isTokenNumber(tokens) ? { tokens } : null;
    },
  },
  sglang: {
    name: "SGLang",
    path: "/v1/tokenize",
    llamaReadiness: false,
    prepareBody: nonStreamingBody,
    responseField: "count",
    errorStatus: null,
    read: (body, status) => {
      const tokens = asObject(body)?.count;
      return status === 200 && isTokenNumber(tokens) ? { tokens } : null;
    },
  },
  vllm: {
    name: "vLLM",
    path: "/v1/chat/completions/render",
    llamaReadiness: false,
    prepareBody: nonStreamingBody,
    responseField: "token_ids",
    errorStatus: 400,
    read: (body, status) => {
      if (status === 400) return vllmOverflow(body);
      const tokens = asObject(body)?.token_ids;
      return status === 200 &&
        Array.isArray(tokens) &&
        tokens.every(isTokenNumber)
        ? { tokens: tokens.length }
        : null;
    },
  },
};
