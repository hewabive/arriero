import { asArray, asObject, asString, numberOrNull } from "./json.js";

export type AnthropicToOpenAiRequestOptions = {
  reasoningField?: "reasoning_content" | "reasoning";
  toolResultImages?: "hoist" | "drop";
  namedToolChoice?: "native" | "filter";
  thinkingBudgetField?: string | null;
  enableThinkingKwargField?: string | null;
  reasoningEffortField?: string | null;
  passthroughKeys?: string[];
};

export type TranslatedAnthropicRequest = {
  body: Record<string, unknown>;
  warnings: string[];
};

const basePassthroughKeys = [
  "model",
  "temperature",
  "top_p",
  "top_k",
  "stream",
  "seed",
  "chat_template_kwargs",
];

const translatedKeys = new Set([
  "system",
  "messages",
  "tools",
  "tool_choice",
  "stop_sequences",
  "max_tokens",
  "thinking",
  "output_config",
  "metadata",
]);

type ImagePart = { type: "image_url"; image_url: { url: string } };

type UserPart = { type: "text"; text: string } | ImagePart;

type TranslationContext = {
  warnings: string[];
  reasoningField: "reasoning_content" | "reasoning";
  toolResultImages: "hoist" | "drop";
};

function imagePart(block: Record<string, unknown>): ImagePart | null {
  const source = asObject(block.source);
  if (!source) {
    return null;
  }
  if (source.type === "base64") {
    const mediaType = asString(source.media_type) ?? "image/jpeg";
    const data = asString(source.data) ?? "";
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${data}` },
    };
  }
  if (source.type === "url") {
    const url = asString(source.url);
    return url ? { type: "image_url", image_url: { url } } : null;
  }
  return null;
}

function systemContent(value: unknown, warnings: string[]): string | null {
  const text = asString(value);
  if (text !== null) {
    return text;
  }
  const blocks = asArray(value);
  if (!blocks) {
    return null;
  }
  let combined = "";
  for (const entry of blocks) {
    const block = asObject(entry);
    if (block?.type === "text") {
      combined += asString(block.text) ?? "";
    } else {
      warnings.push("system: non-text block dropped");
    }
  }
  return combined;
}

function toolResultToMessage(block: Record<string, unknown>): {
  message: Record<string, unknown>;
  images: ImagePart[];
} {
  const images: ImagePart[] = [];
  let text = "";
  const stringContent = asString(block.content);
  if (stringContent !== null) {
    text = stringContent;
  } else {
    for (const entry of asArray(block.content) ?? []) {
      const part = asObject(entry);
      if (!part) {
        continue;
      }
      if (part.type === "text") {
        text += asString(part.text) ?? "";
      }
      if (part.type === "image") {
        const image = imagePart(part);
        if (image) {
          images.push(image);
        }
      }
    }
  }
  return {
    message: {
      role: "tool",
      tool_call_id: asString(block.tool_use_id) ?? "",
      content: text,
    },
    images,
  };
}

function pushUserMessage(
  blocks: unknown[],
  out: Record<string, unknown>[],
  ctx: TranslationContext,
) {
  const toolMessages: Record<string, unknown>[] = [];
  const parts: UserPart[] = [];
  for (const entry of blocks) {
    const block = asObject(entry);
    if (!block) {
      ctx.warnings.push("user message: non-object content block dropped");
      continue;
    }
    if (block.type === "text") {
      parts.push({ type: "text", text: asString(block.text) ?? "" });
      continue;
    }
    if (block.type === "image") {
      const part = imagePart(block);
      if (part) {
        parts.push(part);
      } else {
        ctx.warnings.push("user message: unsupported image source dropped");
      }
      continue;
    }
    if (block.type === "tool_result") {
      const { message, images } = toolResultToMessage(block);
      toolMessages.push(message);
      for (const image of images) {
        if (ctx.toolResultImages === "hoist") {
          parts.push(image);
        } else {
          ctx.warnings.push("tool_result: image block dropped");
        }
      }
      continue;
    }
    ctx.warnings.push(
      `user message: unsupported block type ${String(block.type)} dropped`,
    );
  }
  out.push(...toolMessages);
  if (parts.length === 0) {
    return;
  }
  const only = parts.length === 1 ? parts[0] : null;
  if (only && only.type === "text") {
    out.push({ role: "user", content: only.text });
  } else {
    out.push({ role: "user", content: parts });
  }
}

function pushAssistantMessage(
  blocks: unknown[],
  out: Record<string, unknown>[],
  ctx: TranslationContext,
) {
  let text = "";
  let reasoning = "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const entry of blocks) {
    const block = asObject(entry);
    if (!block) {
      ctx.warnings.push("assistant message: non-object content block dropped");
      continue;
    }
    if (block.type === "text") {
      text += asString(block.text) ?? "";
      continue;
    }
    if (block.type === "thinking") {
      reasoning += asString(block.thinking) ?? "";
      continue;
    }
    if (block.type === "redacted_thinking") {
      ctx.warnings.push("assistant message: redacted_thinking block dropped");
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id: asString(block.id) ?? "",
        type: "function",
        function: {
          name: asString(block.name) ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
      continue;
    }
    ctx.warnings.push(
      `assistant message: unsupported block type ${String(block.type)} dropped`,
    );
  }
  if (!text && !reasoning && toolCalls.length === 0) {
    ctx.warnings.push("assistant message without translatable content dropped");
    return;
  }
  out.push({
    role: "assistant",
    content: text,
    ...(reasoning ? { [ctx.reasoningField]: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });
}

function toolName(tool: Record<string, unknown>): string | null {
  return asString(asObject(tool.function)?.name);
}

function translateTools(
  value: unknown,
  warnings: string[],
): Record<string, unknown>[] | null {
  const tools = asArray(value);
  if (!tools) {
    return null;
  }
  const out: Record<string, unknown>[] = [];
  for (const entry of tools) {
    const tool = asObject(entry);
    if (!tool) {
      continue;
    }
    const name = asString(tool.name);
    const schema = asObject(tool.input_schema);
    if (!name || !schema) {
      warnings.push(
        `tools: ${asString(tool.type) ?? asString(tool.name) ?? "unknown"} tool dropped`,
      );
      continue;
    }
    const description = asString(tool.description);
    out.push({
      type: "function",
      function: {
        name,
        ...(description ? { description } : {}),
        parameters: schema,
      },
    });
  }
  return out;
}

type TranslatedToolChoice = {
  value: unknown;
  filterToolName: string | null;
  parallelToolCalls: boolean | null;
};

function translateToolChoice(
  value: unknown,
  namedMode: "native" | "filter",
  warnings: string[],
): TranslatedToolChoice | null {
  const choice = asObject(value);
  if (!choice) {
    return null;
  }
  const parallelToolCalls: boolean | null =
    choice.disable_parallel_tool_use === true ? false : null;
  if (choice.type === "auto") {
    return { value: "auto", filterToolName: null, parallelToolCalls };
  }
  if (choice.type === "any") {
    return { value: "required", filterToolName: null, parallelToolCalls };
  }
  if (choice.type === "none") {
    return { value: "none", filterToolName: null, parallelToolCalls };
  }
  if (choice.type === "tool") {
    const name = asString(choice.name);
    if (!name) {
      warnings.push("tool_choice: tool without name ignored");
      return null;
    }
    if (namedMode === "native") {
      return {
        value: { type: "function", function: { name } },
        filterToolName: null,
        parallelToolCalls,
      };
    }
    return { value: "required", filterToolName: name, parallelToolCalls };
  }
  warnings.push(`tool_choice: ${String(choice.type)} ignored`);
  return null;
}

export function translateAnthropicRequest(
  input: unknown,
  options: AnthropicToOpenAiRequestOptions = {},
): TranslatedAnthropicRequest {
  const warnings: string[] = [];
  const body = asObject(input) ?? {};
  const ctx: TranslationContext = {
    warnings,
    reasoningField: options.reasoningField ?? "reasoning_content",
    toolResultImages: options.toolResultImages ?? "hoist",
  };
  const passthroughKeys = [
    ...basePassthroughKeys,
    ...(options.passthroughKeys ?? []),
  ];
  const thinkingBudgetField =
    options.thinkingBudgetField === undefined
      ? "thinking_budget_tokens"
      : options.thinkingBudgetField;
  const enableThinkingKwargField = options.enableThinkingKwargField ?? null;
  const reasoningEffortField =
    options.reasoningEffortField === undefined
      ? "reasoning_effort"
      : options.reasoningEffortField;

  const messages: Record<string, unknown>[] = [];
  const system = systemContent(body.system, warnings);
  if (system !== null) {
    messages.push({ role: "system", content: system });
  }

  for (const entry of asArray(body.messages) ?? []) {
    const message = asObject(entry);
    if (!message) {
      warnings.push("messages: non-object entry dropped");
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const stringContent = asString(message.content);
    if (stringContent !== null) {
      messages.push({ role, content: stringContent });
      continue;
    }
    const blocks = asArray(message.content);
    if (!blocks) {
      warnings.push(`messages: ${role} message without content dropped`);
      continue;
    }
    if (role === "assistant") {
      pushAssistantMessage(blocks, messages, ctx);
    } else {
      pushUserMessage(blocks, messages, ctx);
    }
  }

  const out: Record<string, unknown> = { messages };

  let tools = translateTools(body.tools, warnings);
  const toolChoice = translateToolChoice(
    body.tool_choice,
    options.namedToolChoice ?? "native",
    warnings,
  );
  if (toolChoice) {
    if (toolChoice.filterToolName !== null && tools) {
      const filtered = tools.filter(
        (tool) => toolName(tool) === toolChoice.filterToolName,
      );
      if (filtered.length > 0) {
        tools = filtered;
      } else {
        warnings.push(
          `tool_choice: tool ${toolChoice.filterToolName} not found in tools`,
        );
      }
    }
    out.tool_choice = toolChoice.value;
    if (toolChoice.parallelToolCalls === false) {
      out.parallel_tool_calls = false;
    }
  }
  if (tools && tools.length > 0) {
    out.tools = tools;
  }

  if (numberOrNull(body.max_tokens) !== null) {
    out.max_tokens = body.max_tokens;
  }
  const stop = asArray(body.stop_sequences);
  if (stop) {
    out.stop = stop;
  }

  const thinking = asObject(body.thinking);
  const thinkingType = thinking ? asString(thinking.type) : null;
  if (thinking) {
    if (thinkingType === "enabled" && thinkingBudgetField) {
      out[thinkingBudgetField] = numberOrNull(thinking.budget_tokens) ?? 10000;
    } else if (
      thinkingType !== "enabled" &&
      thinkingType !== "disabled" &&
      thinkingType !== "adaptive"
    ) {
      warnings.push(
        `thinking: ${String(thinking.type)} not supported by upstream`,
      );
    }
  }

  const outputConfig = asObject(body.output_config);
  if (outputConfig) {
    const effort = asString(outputConfig.effort);
    if (effort && reasoningEffortField) {
      out[reasoningEffortField] = effort;
    } else if (effort) {
      warnings.push("output_config.effort dropped");
    }
    for (const key of Object.keys(outputConfig)) {
      if (key !== "effort") {
        warnings.push(`output_config.${key} dropped`);
      }
    }
  }

  const userId = asString(asObject(body.metadata)?.user_id);
  if (userId) {
    out.user = userId;
  }

  for (const key of passthroughKeys) {
    if (key in body) {
      out[key] = body[key];
    }
  }

  if (
    enableThinkingKwargField &&
    (thinkingType === "enabled" ||
      thinkingType === "adaptive" ||
      thinkingType === "disabled")
  ) {
    const existing = asObject(out.chat_template_kwargs) ?? {};
    out.chat_template_kwargs = {
      ...existing,
      [enableThinkingKwargField]: thinkingType !== "disabled",
    };
  }

  for (const key of Object.keys(body)) {
    if (!translatedKeys.has(key) && !passthroughKeys.includes(key)) {
      warnings.push(`unsupported field ${key} dropped`);
    }
  }

  return { body: out, warnings };
}
