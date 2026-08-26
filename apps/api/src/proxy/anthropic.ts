import { asObject } from "./json.js";
import { apiProxySseEventFrame } from "./response-codec.js";
import {
  apiProxyOperationSpec,
  modelIdFromBody,
  type ApiProxyProtocolAdapter,
  type ApiProxyProtocolOperation,
  type ApiProxyResumableCodec,
  type ApiProxyResumableToolCall,
} from "./protocol.js";
import {
  anthropicCacheCreationTokens,
  anthropicCacheReadTokens,
  anthropicPromptTokens,
} from "./usage-meter.js";

export type AnthropicErrorType =
  | "invalid_request_error"
  | "not_found_error"
  | "permission_error"
  | "conflict_error"
  | "overloaded_error"
  | "api_error";

export function anthropicError(input: {
  message: string;
  type: AnthropicErrorType;
}) {
  return {
    type: "error",
    error: {
      type: input.type,
      message: input.message,
    },
  };
}

function endpointLabel(operation: ApiProxyProtocolOperation) {
  return operation.routePath || operation.endpoint;
}

function parseToolInput(args: string): unknown {
  if (!args.trim()) {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function anthropicToolBlocks(
  toolCalls: ApiProxyResumableToolCall[] | undefined,
) {
  return (toolCalls ?? [])
    .filter((call) => call.name)
    .map((call, index) => ({
      type: "tool_use",
      id: call.id ?? `toolu_arriero_${index}`,
      name: call.name ?? "",
      input: parseToolInput(call.arguments),
    }));
}

export const anthropicResumableCodec: ApiProxyResumableCodec = {
  upstreamBody(originalBody, tail) {
    const base = asObject(originalBody) ?? {};
    const messages = Array.isArray(base.messages) ? [...base.messages] : [];
    const next =
      tail !== null
        ? [...messages, { role: "assistant", content: tail }]
        : messages;
    return { ...base, messages: next, stream: true };
  },
  parseChunk(data) {
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

    if (event.type === "message_stop") {
      return "done";
    }
    if (event.type === "content_block_start") {
      const block = asObject(event.content_block);
      if (block?.type === "tool_use") {
        return {
          text: "",
          finishReason: null,
          id: null,
          model: null,
          phase: "tool",
          toolCall: {
            index: typeof event.index === "number" ? event.index : 0,
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            ...(typeof block.name === "string" ? { name: block.name } : {}),
          },
        };
      }
      return null;
    }
    if (event.type === "content_block_delta") {
      const delta = asObject(event.delta);
      if (delta?.type === "thinking_delta") {
        return {
          text: "",
          finishReason: null,
          id: null,
          model: null,
          phase: "thinking",
          ...(typeof delta.thinking === "string"
            ? { reasoning: delta.thinking }
            : {}),
        };
      }
      if (delta?.type === "input_json_delta") {
        return {
          text: "",
          finishReason: null,
          id: null,
          model: null,
          phase: "tool",
          toolCall: {
            index: typeof event.index === "number" ? event.index : 0,
            ...(typeof delta.partial_json === "string"
              ? { arguments: delta.partial_json }
              : {}),
          },
        };
      }
      const text =
        delta?.type === "text_delta" && typeof delta.text === "string"
          ? delta.text
          : "";
      return {
        text,
        finishReason: null,
        id: null,
        model: null,
        ...(text ? { phase: "text" as const } : {}),
      };
    }
    if (event.type === "message_start") {
      const message = asObject(event.message);
      const usage = asObject(message?.usage);
      return {
        text: "",
        finishReason: null,
        id: typeof message?.id === "string" ? message.id : null,
        model: typeof message?.model === "string" ? message.model : null,
        usage: {
          promptTokens: anthropicPromptTokens(usage),
          cacheReadTokens: anthropicCacheReadTokens(usage),
          cacheCreationTokens: anthropicCacheCreationTokens(usage),
          completionTokens: null,
        },
      };
    }
    if (event.type === "message_delta") {
      const delta = asObject(event.delta);
      const usage = asObject(event.usage);
      return {
        text: "",
        finishReason:
          typeof delta?.stop_reason === "string" ? delta.stop_reason : null,
        id: null,
        model: null,
        usage: {
          promptTokens: anthropicPromptTokens(usage),
          cacheReadTokens: anthropicCacheReadTokens(usage),
          cacheCreationTokens: anthropicCacheCreationTokens(usage),
          completionTokens:
            typeof usage?.output_tokens === "number"
              ? usage.output_tokens
              : null,
        },
      };
    }
    return null;
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
    toolCalls,
  }) {
    const resolvedId = id ?? "msg_arriero";
    const resolvedModel = model ?? "unknown";
    const inputTokens = promptTokens ?? 0;
    const outputTokens = completionTokens ?? 0;

    const toolBlocks = anthropicToolBlocks(toolCalls);
    const hasTools = toolBlocks.length > 0;
    const stopReason = finishReason ?? (hasTools ? "tool_use" : "end_turn");
    const thinkingBlocks =
      reasoningText && reasoningText.length > 0
        ? [{ type: "thinking", thinking: reasoningText, signature: "" }]
        : [];
    const textBlocks = text.length > 0 ? [{ type: "text", text }] : [];
    const contentBlocks =
      thinkingBlocks.length > 0 || textBlocks.length > 0 || hasTools
        ? [...thinkingBlocks, ...textBlocks, ...toolBlocks]
        : [{ type: "text", text: "" }];

    if (wantsStream) {
      const event = apiProxySseEventFrame;
      let body = event("message_start", {
        type: "message_start",
        message: {
          id: resolvedId,
          type: "message",
          role: "assistant",
          model: resolvedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });
      contentBlocks.forEach((block, index) => {
        if (block.type === "thinking") {
          const thinking = block as { thinking: string; signature: string };
          body +=
            event("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "thinking", thinking: "" },
            }) +
            event("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: thinking.thinking },
            }) +
            event("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: thinking.signature },
            }) +
            event("content_block_stop", {
              type: "content_block_stop",
              index,
            });
          return;
        }
        if (block.type === "tool_use") {
          const tool = block as { id: string; name: string; input: unknown };
          body +=
            event("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: tool.id,
                name: tool.name,
                input: {},
              },
            }) +
            event("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(tool.input),
              },
            }) +
            event("content_block_stop", {
              type: "content_block_stop",
              index,
            });
          return;
        }
        const textBlock = block as { text: string };
        body +=
          event("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }) +
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: textBlock.text },
          }) +
          event("content_block_stop", {
            type: "content_block_stop",
            index,
          });
      });
      body +=
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }) + event("message_stop", { type: "message_stop" });
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      };
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: resolvedId,
        type: "message",
        role: "assistant",
        model: resolvedModel,
        content: contentBlocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }),
    };
  },
};

export const anthropicProtocolAdapter: ApiProxyProtocolAdapter = {
  id: "anthropic",
  displayName: "Anthropic Messages",
  resumable: anthropicResumableCodec,
  modelIdFromBody,
  missingModel: () => ({
    status: 400,
    body: anthropicError({
      message: "Request body must include a non-empty model field.",
      type: "invalid_request_error",
    }),
  }),
  modelNotFound: (modelId) => ({
    status: 404,
    body: anthropicError({
      message: `Model ${modelId} is not published by arriero proxy.`,
      type: "not_found_error",
    }),
  }),
  diagnosticError: (_request, diagnostic) => {
    const plainClientError = diagnostic.errorClass === "invalid-request";
    return {
      status: diagnostic.status,
      body: anthropicError({
        message: plainClientError
          ? diagnostic.message
          : `${diagnostic.message} (${diagnostic.code})`,
        type: plainClientError
          ? "invalid_request_error"
          : diagnostic.errorClass === "conflict"
            ? "conflict_error"
            : "api_error",
      }),
      ...(diagnostic.retryable === false
        ? { headers: { "x-should-retry": "false" } }
        : {}),
    };
  },
  authError: (diagnostic) => ({
    status: diagnostic.status,
    body: anthropicError({
      message: diagnostic.message,
      type: "permission_error",
    }),
  }),
  unavailableError: (message) =>
    anthropicError({ message, type: "overloaded_error" }),
  upstreamPath: (operation) =>
    apiProxyOperationSpec(operation)?.upstreamPath ?? null,
  notImplemented: (request) => ({
    status: 501,
    body: anthropicError({
      message: `Model ${request.modelId} is published by arriero, but ${endpointLabel(
        request.operation,
      )} forwarding is not implemented yet.`,
      type: "api_error",
    }),
  }),
};
