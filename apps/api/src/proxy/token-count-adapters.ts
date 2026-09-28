import type { EngineTokenCountId } from "@arriero/core";

import { apiProxyForwardUrl } from "./forwarder.js";
import { asObject } from "./json.js";
import { stripV1BaseUrl } from "./targets.js";

export type ApiProxyTokenMeasurement =
  | { tokens: number }
  | { minimumTokens: number };

type TokenCountReadinessCheck = {
  baseUrl: string;
  model: unknown;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
};

type TokenCountAdapter = {
  name: string;
  path: string;
  countQuery: string;
  readiness?: (check: TokenCountReadinessCheck) => Promise<string | null>;
  supportsRequest: (body: unknown) => boolean;
  prepareBody: (body: Record<string, unknown>) => Record<string, unknown>;
  read: (body: unknown, status: number) => ApiProxyTokenMeasurement | null;
  responseField: string;
  errorStatus: number | null;
};

async function llamaReadiness(
  check: TokenCountReadinessCheck,
): Promise<string | null> {
  const query = new URLSearchParams({ autoload: "false" });
  if (typeof check.model === "string") query.set("model", check.model);
  const response = await check.fetchImpl(
    apiProxyForwardUrl(
      stripV1BaseUrl(check.baseUrl),
      "/props",
      query.toString(),
    ),
    { headers: check.headers, signal: check.signal, redirect: "error" },
  );
  if (!response.ok) {
    await response.body?.cancel();
    return `readiness check returned HTTP ${response.status}`;
  }
  const props = asObject(await response.json());
  return props?.is_sleeping !== false
    ? "model is sleeping or readiness is unknown"
    : null;
}

function supportsChatRequest(body: unknown, supportsImages = false): boolean {
  const messages = asObject(body)?.messages;
  return (
    Array.isArray(messages) &&
    messages.every((message) => {
      const item = asObject(message);
      if (!item || item.audio != null) return false;
      const content = item.content;
      return (
        content == null ||
        typeof content === "string" ||
        (Array.isArray(content) &&
          content.every((part) => {
            const block = asObject(part);
            return (
              (block?.type === "text" && typeof block.text === "string") ||
              (supportsImages &&
                block?.type === "image_url" &&
                typeof asObject(block.image_url)?.url === "string")
            );
          }))
      );
    })
  );
}

function isTokenNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countFieldReader(
  field: string,
): Pick<TokenCountAdapter, "responseField" | "read"> {
  return {
    responseField: field,
    read: (body, status) => {
      const tokens = asObject(body)?.[field];
      return status === 200 && isTokenNumber(tokens) ? { tokens } : null;
    },
  };
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
    countQuery: "autoload=false",
    readiness: llamaReadiness,
    supportsRequest: (body) => supportsChatRequest(body, true),
    prepareBody: (body) => body,
    ...countFieldReader("input_tokens"),
    errorStatus: null,
  },
  sglang: {
    name: "SGLang",
    path: "/v1/tokenize",
    countQuery: "",
    supportsRequest: supportsChatRequest,
    prepareBody: nonStreamingBody,
    ...countFieldReader("count"),
    errorStatus: null,
  },
  vllm: {
    name: "vLLM",
    path: "/v1/chat/completions/render",
    countQuery: "",
    supportsRequest: supportsChatRequest,
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
