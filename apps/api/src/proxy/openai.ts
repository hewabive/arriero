import type {
  ApiProxyModelRecord,
  ApiProxyPublicModelStatus,
} from "@arriero/core";
import { asObject } from "./json.js";
import {
  modelIdFromBody,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
  type ApiProxyResumablePhase,
  type ApiProxyResumableToolCallDelta,
} from "./protocol.js";
import { openaiCachedTokens } from "./usage-meter.js";

export type OpenAiErrorType =
  | "invalid_request_error"
  | "not_found_error"
  | "permission_error"
  | "server_error";

function openAiError(input: {
  message: string;
  type: OpenAiErrorType;
  code: string;
  param?: string | null | undefined;
}) {
  return {
    error: {
      message: input.message,
      type: input.type,
      param: input.param ?? null,
      code: input.code,
    },
  };
}

export function openAiModelsList(
  models: ApiProxyModelRecord[],
  statusByModelId?: Map<string, ApiProxyPublicModelStatus>,
) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: models
      .filter((model) => model.visible)
      .map((model) => {
        const status = statusByModelId?.get(model.modelId);
        return {
          id: model.modelId,
          object: "model",
          created,
          owned_by: model.ownedBy,
          ...(status
            ? {
                status: {
                  value: status.value,
                  active_requests: status.activeRequests,
                  queued_requests: status.queuedRequests,
                },
              }
            : {}),
        };
      }),
  };
}

export function notImplementedResponse(modelId: string, endpoint: string) {
  return openAiError({
    message: `Model ${modelId} is published by arriero, but ${endpoint} forwarding is not implemented yet.`,
    type: "server_error",
    code: "arriero_proxy_not_implemented",
    param: "model",
  });
}

function endpointLabel(operation: ApiProxyProtocolOperation) {
  return operation.routePath || operation.endpoint;
}

const upstreamPaths: Record<string, string> = {
  "chat.completions": "/v1/chat/completions",
  completions: "/v1/completions",
  embeddings: "/v1/embeddings",
  rerank: "/v1/rerank",
  responses: "/v1/responses",
};

export const openAiResumableCodec: ApiProxyResumableCodec = {
  upstreamBody(originalBody, tail) {
    const base = asObject(originalBody) ?? {};
    const messages = Array.isArray(base.messages) ? [...base.messages] : [];
    const next =
      tail !== null
        ? [...messages, { role: "assistant", content: tail }]
        : messages;
    return {
      ...base,
      messages: next,
      stream: true,
      stream_options: { include_usage: true },
    };
  },
  parseChunk(data) {
    if (data === "[DONE]") {
      return "done";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "malformed";
    }
    const event = asObject(parsed);
    if (!event) {
      return "malformed";
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const choice = asObject(choices[0]);
    const delta = asObject(choice?.delta);
    const content = typeof delta?.content === "string" ? delta.content : "";
    const usage = asObject(event.usage);
    const timings = asObject(event.timings);
    const predictedMs =
      timings &&
      typeof timings.predicted_ms === "number" &&
      Number.isFinite(timings.predicted_ms)
        ? timings.predicted_ms
        : null;
    const promptProgress = asObject(event.prompt_progress);

    const deltaToolCalls = Array.isArray(delta?.tool_calls)
      ? delta.tool_calls
      : null;
    const reasoning =
      typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : "";
    let toolCall: ApiProxyResumableToolCallDelta | undefined;
    let phase: ApiProxyResumablePhase | undefined;
    if (deltaToolCalls && deltaToolCalls.length > 0) {
      const entry = asObject(deltaToolCalls[0]);
      const fn = asObject(entry?.function);
      toolCall = {
        index: typeof entry?.index === "number" ? entry.index : 0,
        ...(typeof entry?.id === "string" ? { id: entry.id } : {}),
        ...(typeof fn?.name === "string" ? { name: fn.name } : {}),
        ...(typeof fn?.arguments === "string"
          ? { arguments: fn.arguments }
          : {}),
      };
      phase = "tool";
    } else if (reasoning) {
      phase = "thinking";
    } else if (content) {
      phase = "text";
    }

    return {
      text: content,
      finishReason:
        typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      id: typeof event.id === "string" ? event.id : null,
      model: typeof event.model === "string" ? event.model : null,
      ...(reasoning ? { reasoning } : {}),
      ...(phase ? { phase } : {}),
      ...(toolCall ? { toolCall } : {}),
      ...(predictedMs !== null ? { genMs: Math.round(predictedMs) } : {}),
      ...(promptProgress &&
      typeof promptProgress.total === "number" &&
      typeof promptProgress.processed === "number"
        ? {
            promptProgress: {
              total: promptProgress.total,
              processed: promptProgress.processed,
              cache:
                typeof promptProgress.cache === "number"
                  ? promptProgress.cache
                  : 0,
            },
          }
        : {}),
      ...(usage
        ? {
            usage: {
              promptTokens:
                typeof usage.prompt_tokens === "number"
                  ? usage.prompt_tokens
                  : null,
              cacheReadTokens: openaiCachedTokens(usage),
              completionTokens:
                typeof usage.completion_tokens === "number"
                  ? usage.completion_tokens
                  : null,
            },
          }
        : {}),
    };
  },
  finalResponse({
    text,
    reasoningText,
    id,
    model,
    finishReason,
    wantsStream,
    completionTokens,
    promptTokens,
    genMs,
    toolCalls,
  }) {
    const created = Math.floor(Date.now() / 1000);
    const resolvedId = id ?? "chatcmpl-arriero";
    const resolvedModel = model ?? "unknown";
    const reasoning =
      reasoningText && reasoningText.length > 0
        ? { reasoning_content: reasoningText }
        : {};

    const resolvedToolCalls = (toolCalls ?? [])
      .filter((call) => call.name)
      .map((call, index) => ({
        id: call.id ?? `call_${index}`,
        type: "function",
        function: { name: call.name ?? "", arguments: call.arguments },
      }));
    const hasToolCalls = resolvedToolCalls.length > 0;
    const finish = finishReason ?? (hasToolCalls ? "tool_calls" : "stop");
    const messageContent = text.length > 0 ? text : hasToolCalls ? null : "";

    const completion = completionTokens ?? 0;
    const prompt = promptTokens ?? null;
    const usage =
      completion > 0
        ? {
            prompt_tokens: prompt ?? 0,
            completion_tokens: completion,
            total_tokens: (prompt ?? 0) + completion,
          }
        : null;
    const timings =
      completion > 0 && genMs && genMs > 0
        ? {
            predicted_n: completion,
            predicted_ms: genMs,
            predicted_per_second: completion / (genMs / 1000),
          }
        : null;

    if (wantsStream) {
      const chunk = (extra: Record<string, unknown>) =>
        `data: ${JSON.stringify({
          id: resolvedId,
          object: "chat.completion.chunk",
          created,
          model: resolvedModel,
          ...extra,
        })}\n\n`;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body:
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: messageContent,
                  ...reasoning,
                  ...(hasToolCalls
                    ? {
                        tool_calls: resolvedToolCalls.map((call, index) => ({
                          index,
                          ...call,
                        })),
                      }
                    : {}),
                },
                finish_reason: null,
              },
            ],
          }) +
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) +
          (usage
            ? chunk({ choices: [], usage, ...(timings ? { timings } : {}) })
            : "") +
          "data: [DONE]\n\n",
      };
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: resolvedId,
        object: "chat.completion",
        created,
        model: resolvedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: messageContent,
              ...reasoning,
              ...(hasToolCalls ? { tool_calls: resolvedToolCalls } : {}),
            },
            finish_reason: finish,
          },
        ],
        ...(usage ? { usage } : {}),
        ...(timings ? { timings } : {}),
      }),
    };
  },
};

export const openAiProtocolAdapter: ApiProxyProtocolAdapter = {
  id: "openai",
  displayName: "OpenAI-compatible",
  resumable: openAiResumableCodec,
  modelIdFromBody,
  missingModel: () => ({
    status: 400,
    body: openAiError({
      message: "Request body must include a non-empty model field.",
      type: "invalid_request_error",
      code: "missing_model",
      param: "model",
    }),
  }),
  modelNotFound: (modelId) => ({
    status: 404,
    body: openAiError({
      message: `Model ${modelId} is not published by arriero proxy.`,
      type: "not_found_error",
      code: "model_not_found",
      param: "model",
    }),
  }),
  diagnosticError: (_request, diagnostic) => ({
    status: diagnostic.status,
    body: openAiError({
      message: diagnostic.message,
      type: diagnostic.errorClass ? "invalid_request_error" : "server_error",
      code: diagnostic.code,
      param: diagnostic.param,
    }),
    ...(diagnostic.retryable === false
      ? { headers: { "x-should-retry": "false" } }
      : {}),
  }),
  authError: (diagnostic) => ({
    status: diagnostic.status,
    body: openAiError({
      message: diagnostic.message,
      type: "permission_error",
      code: diagnostic.code,
    }),
  }),
  upstreamPath: (operation) => upstreamPaths[operation.endpoint] ?? null,
  notImplemented: (request) => ({
    status: 501,
    body: notImplementedResponse(
      request.modelId,
      endpointLabel(request.operation),
    ),
  }),
};

export const openAiResponsesUsageCodec: Pick<
  ApiProxyResumableCodec,
  "parseChunk"
> = {
  parseChunk(data) {
    if (data === "[DONE]") {
      return "done";
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "malformed";
    }
    const event = asObject(parsed);
    if (!event) {
      return "malformed";
    }
    const type = typeof event.type === "string" ? event.type : null;
    if (type === "response.completed") {
      const response = asObject(event.response);
      const usage = asObject(response?.usage);
      return {
        text: "",
        finishReason: "stop",
        id: null,
        model: null,
        ...(usage
          ? {
              usage: {
                promptTokens:
                  typeof usage.input_tokens === "number"
                    ? usage.input_tokens
                    : null,
                cacheReadTokens: openaiCachedTokens(usage),
                completionTokens:
                  typeof usage.output_tokens === "number"
                    ? usage.output_tokens
                    : null,
              },
            }
          : {}),
      };
    }
    if (
      type === "response.output_text.delta" ||
      type === "response.reasoning_text.delta"
    ) {
      return {
        text: typeof event.delta === "string" ? event.delta : "",
        finishReason: null,
        id: null,
        model: null,
      };
    }
    return null;
  },
};
