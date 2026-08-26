import type { ApiProxyModelRecord } from "@arriero/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { CLIENT_ABORT_STATUS } from "./http.js";
import { asObject } from "./json.js";

export type ApiProxyProtocolId = "openai" | "anthropic";

export type ApiProxyProtocolTransport = "http-json" | "sse" | "websocket";

export type ApiProxyProtocolOperation = {
  protocol: ApiProxyProtocolId;
  endpoint: string;
  routePath: string;
  transport: ApiProxyProtocolTransport;
};

export type ApiProxyProtocolResponse = {
  status: ContentfulStatusCode;
  body: unknown;
  headers?: Record<string, string>;
};

type ApiProxyProtocolDiagnosticCode =
  | "arriero_proxy_model_unbound"
  | "arriero_proxy_model_disabled"
  | "arriero_proxy_target_not_found"
  | "arriero_proxy_plan_blocked"
  | "arriero_proxy_target_not_ready"
  | "arriero_proxy_pipeline_not_found"
  | "arriero_proxy_pipeline_disabled"
  | "arriero_proxy_pipeline_cycle"
  | "arriero_proxy_route_unbound"
  | "arriero_proxy_route_invalid"
  | "arriero_proxy_context_overflow"
  | "arriero_proxy_action_unsupported"
  | "arriero_proxy_instance_not_found"
  | "arriero_proxy_instance_start_failed"
  | "arriero_proxy_upstream_unavailable"
  | "arriero_proxy_upstream_timeout"
  | "arriero_proxy_upstream_error";

export type ApiProxyProtocolDiagnostic = {
  status: ContentfulStatusCode;
  code: ApiProxyProtocolDiagnosticCode;
  message: string;
  param?: string | null | undefined;
  errorClass?: "invalid-request" | "conflict" | undefined;
  retryable?: boolean | undefined;
};

type ApiProxyAuthDiagnosticCode =
  | "arriero_proxy_source_required"
  | "arriero_proxy_source_disabled"
  | "invalid_api_key";

export type ApiProxyAuthDiagnostic = {
  status: 423;
  code: ApiProxyAuthDiagnosticCode;
  message: string;
};

export type ApiProxyProtocolModelRequest = {
  operation: ApiProxyProtocolOperation;
  body: unknown;
  modelId: string;
  model: ApiProxyModelRecord;
  stream: boolean;
};

export type ApiProxyProtocolModelResolution =
  | {
      ok: true;
      request: ApiProxyProtocolModelRequest;
    }
  | {
      ok: false;
      response: ApiProxyProtocolResponse;
    };

type ApiProxyResumableUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
};

export type ApiProxyResumablePhase = "text" | "thinking" | "tool";

export type ApiProxyResumableToolCallDelta = {
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  arguments?: string | undefined;
};

export type ApiProxyResumableToolCall = {
  id: string | null;
  name: string | null;
  arguments: string;
};

type ApiProxyResumablePromptProgress = {
  total: number;
  cache: number;
  processed: number;
};

type ApiProxyResumableStreamChunk = {
  text: string;
  finishReason: string | null;
  id: string | null;
  model: string | null;
  reasoning?: string | undefined;
  usage?: ApiProxyResumableUsage | undefined;
  genMs?: number | undefined;
  phase?: ApiProxyResumablePhase | undefined;
  toolCall?: ApiProxyResumableToolCallDelta | undefined;
  promptProgress?: ApiProxyResumablePromptProgress | undefined;
};

export type ApiProxyResumableFinalResponse = {
  status: ContentfulStatusCode | typeof CLIENT_ABORT_STATUS;
  headers: Record<string, string>;
  body: string;
};

export type ApiProxyResumableCodec = {
  upstreamBody: (originalBody: unknown, tail: string | null) => unknown;
  parseChunk: (
    data: string,
  ) => ApiProxyResumableStreamChunk | "done" | "malformed" | null;
  finalResponse: (input: {
    text: string;
    id: string | null;
    model: string | null;
    finishReason: string | null;
    wantsStream: boolean;
    reasoningText?: string | undefined;
    completionTokens?: number | undefined;
    promptTokens?: number | null | undefined;
    genMs?: number | undefined;
    toolCalls?: ApiProxyResumableToolCall[] | undefined;
  }) => ApiProxyResumableFinalResponse;
};

export type ApiProxyProtocolAdapter = {
  id: ApiProxyProtocolId;
  displayName: string;
  resumable?: ApiProxyResumableCodec | undefined;
  modelIdFromBody: (body: unknown) => string | null;
  missingModel: (
    operation: ApiProxyProtocolOperation,
  ) => ApiProxyProtocolResponse;
  modelNotFound: (
    modelId: string,
    operation: ApiProxyProtocolOperation,
  ) => ApiProxyProtocolResponse;
  diagnosticError: (
    request: ApiProxyProtocolModelRequest,
    diagnostic: ApiProxyProtocolDiagnostic,
  ) => ApiProxyProtocolResponse;
  authError: (diagnostic: ApiProxyAuthDiagnostic) => ApiProxyProtocolResponse;
  unavailableError: (message: string) => unknown;
  upstreamPath: (operation: ApiProxyProtocolOperation) => string | null;
  notImplemented: (
    request: ApiProxyProtocolModelRequest,
  ) => ApiProxyProtocolResponse;
};

export type ApiProxyResponseShape =
  | "anthropic"
  | "openai-responses"
  | "openai-chat";

export type ApiProxyOperationBodyMode = "json";

type ApiProxyOperationSpec = {
  protocol: ApiProxyProtocolId;
  upstreamPath: string;
  bodyMode: ApiProxyOperationBodyMode;
  responseShape: ApiProxyResponseShape;
  resumable: boolean;
  promptProgress: boolean;
  usageMeter: "resumable" | "responses" | null;
  translatesToOpenAiChat: boolean;
  countTokensResponse: boolean;
};

const apiProxyOperationSpecs = {
  "chat.completions": {
    protocol: "openai",
    upstreamPath: "/v1/chat/completions",
    bodyMode: "json",
    responseShape: "openai-chat",
    resumable: true,
    promptProgress: true,
    usageMeter: "resumable",
    translatesToOpenAiChat: false,
    countTokensResponse: false,
  },
  completions: {
    protocol: "openai",
    upstreamPath: "/v1/completions",
    bodyMode: "json",
    responseShape: "openai-chat",
    resumable: false,
    promptProgress: false,
    usageMeter: null,
    translatesToOpenAiChat: false,
    countTokensResponse: false,
  },
  embeddings: {
    protocol: "openai",
    upstreamPath: "/v1/embeddings",
    bodyMode: "json",
    responseShape: "openai-chat",
    resumable: false,
    promptProgress: false,
    usageMeter: null,
    translatesToOpenAiChat: false,
    countTokensResponse: false,
  },
  rerank: {
    protocol: "openai",
    upstreamPath: "/v1/rerank",
    bodyMode: "json",
    responseShape: "openai-chat",
    resumable: false,
    promptProgress: false,
    usageMeter: null,
    translatesToOpenAiChat: false,
    countTokensResponse: false,
  },
  responses: {
    protocol: "openai",
    upstreamPath: "/v1/responses",
    bodyMode: "json",
    responseShape: "openai-responses",
    resumable: false,
    promptProgress: false,
    usageMeter: "responses",
    translatesToOpenAiChat: false,
    countTokensResponse: false,
  },
  messages: {
    protocol: "anthropic",
    upstreamPath: "/v1/messages",
    bodyMode: "json",
    responseShape: "anthropic",
    resumable: true,
    promptProgress: false,
    usageMeter: "resumable",
    translatesToOpenAiChat: true,
    countTokensResponse: false,
  },
  "messages.count_tokens": {
    protocol: "anthropic",
    upstreamPath: "/v1/messages/count_tokens",
    bodyMode: "json",
    responseShape: "anthropic",
    resumable: false,
    promptProgress: false,
    usageMeter: null,
    translatesToOpenAiChat: false,
    countTokensResponse: true,
  },
} satisfies Record<string, ApiProxyOperationSpec>;

export type ApiProxyEndpointName = keyof typeof apiProxyOperationSpecs;

export function apiProxyOperationSpec(
  operation: Pick<ApiProxyProtocolOperation, "protocol" | "endpoint">,
): ApiProxyOperationSpec | null {
  if (!Object.hasOwn(apiProxyOperationSpecs, operation.endpoint)) {
    return null;
  }
  const spec =
    apiProxyOperationSpecs[operation.endpoint as ApiProxyEndpointName];
  return spec.protocol === operation.protocol ? spec : null;
}

export function apiProxyResponseShape(
  operation: ApiProxyProtocolOperation,
): ApiProxyResponseShape {
  const spec = apiProxyOperationSpec(operation);
  if (spec) {
    return spec.responseShape;
  }
  return operation.protocol === "anthropic" ? "anthropic" : "openai-chat";
}

export function bodyRequestsStreaming(body: unknown) {
  return asObject(body)?.stream === true;
}

export function modelIdFromBody(body: unknown): string | null {
  const model = asObject(body)?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

export function resolveApiProxyProtocolModelRequest(input: {
  adapter: ApiProxyProtocolAdapter;
  operation: ApiProxyProtocolOperation;
  body: unknown;
  getModelByModelId: (modelId: string) => ApiProxyModelRecord | null;
}): ApiProxyProtocolModelResolution {
  const modelId = input.adapter.modelIdFromBody(input.body);
  if (!modelId) {
    return {
      ok: false,
      response: input.adapter.missingModel(input.operation),
    };
  }

  const model = input.getModelByModelId(modelId);
  if (!model) {
    return {
      ok: false,
      response: input.adapter.modelNotFound(modelId, input.operation),
    };
  }

  return {
    ok: true,
    request: {
      operation: input.operation,
      body: input.body,
      modelId,
      model,
      stream: bodyRequestsStreaming(input.body),
    },
  };
}
