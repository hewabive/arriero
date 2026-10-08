import { asObject, isRecord, type JsonRecord } from "./json.js";
import type {
  ApiProxyResponseShape,
  ApiProxyResumableToolCallDelta,
} from "./protocol.js";

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function idsOf(items: JsonRecord[], field: string): string[] {
  return items
    .map((item) => nonEmptyString(item[field]))
    .filter((id): id is string => id !== null);
}

function trailing(
  items: JsonRecord[],
  matches: (item: JsonRecord) => boolean,
): JsonRecord[] {
  let start = items.length;
  while (start > 0 && matches(items[start - 1]!)) {
    start -= 1;
  }
  return items.slice(start);
}

function isClientToolOutput(item: JsonRecord): boolean {
  return (
    typeof item.type === "string" &&
    item.type.endsWith("_call_output") &&
    nonEmptyString(item.call_id) !== null
  );
}

const trailingToolResultReaders: Record<
  ApiProxyResponseShape,
  (body: JsonRecord) => string[] | null
> = {
  "openai-chat": (body) => {
    const results = trailing(
      records(body.messages),
      (message) => message.role === "tool",
    );
    return results.length > 0 ? idsOf(results, "tool_call_id") : null;
  },
  "openai-responses": (body) => {
    const outputs = trailing(records(body.input), isClientToolOutput);
    return outputs.length > 0 ? idsOf(outputs, "call_id") : null;
  },
  anthropic: (body) => {
    const last = records(body.messages).at(-1);
    if (last?.role !== "user") {
      return null;
    }
    const results = records(last.content).filter(
      (block) => block.type === "tool_result",
    );
    return results.length > 0 ? idsOf(results, "tool_use_id") : null;
  },
};

export function trailingToolResultIds(
  shape: ApiProxyResponseShape,
  body: unknown,
): string[] | null {
  const record = asObject(body);
  return record ? trailingToolResultReaders[shape](record) : null;
}

function argumentsText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined ? undefined : JSON.stringify(value);
}

function toolCallDelta(
  index: number,
  id: unknown,
  name: unknown,
  args: unknown,
): ApiProxyResumableToolCallDelta {
  const callId = nonEmptyString(id);
  const callName = nonEmptyString(name);
  const callArguments = argumentsText(args);
  return {
    index,
    ...(callId !== null ? { id: callId } : {}),
    ...(callName !== null ? { name: callName } : {}),
    ...(callArguments !== undefined ? { arguments: callArguments } : {}),
  };
}

const responseToolCallReaders: Record<
  ApiProxyResponseShape,
  (body: JsonRecord) => ApiProxyResumableToolCallDelta[]
> = {
  "openai-chat": (body) => {
    const message = asObject(records(body.choices)[0]?.message);
    return records(message?.tool_calls).map((call, index) => {
      const fn = asObject(call.function);
      return toolCallDelta(index, call.id, fn?.name, fn?.arguments);
    });
  },
  "openai-responses": (body) =>
    records(body.output)
      .filter((item) => nonEmptyString(item.call_id) !== null)
      .map((item, index) =>
        toolCallDelta(
          index,
          item.call_id,
          item.name,
          item.arguments ?? item.input,
        ),
      ),
  anthropic: (body) =>
    records(body.content)
      .filter((block) => block.type === "tool_use")
      .map((block, index) =>
        toolCallDelta(index, block.id, block.name, block.input),
      ),
};

export function responseToolCalls(
  shape: ApiProxyResponseShape,
  body: unknown,
): ApiProxyResumableToolCallDelta[] | null {
  const record = asObject(body);
  return record ? responseToolCallReaders[shape](record) : null;
}
