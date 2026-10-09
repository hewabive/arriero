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

function trailingRecords(
  value: unknown,
  matches: (item: JsonRecord) => boolean,
): JsonRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const trailing: JsonRecord[] = [];
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item: unknown = value[index];
    if (!isRecord(item)) {
      continue;
    }
    if (!matches(item)) {
      break;
    }
    trailing.push(item);
  }
  return trailing.reverse();
}

function lastRecord(value: unknown): JsonRecord | undefined {
  return Array.isArray(value) ? value.findLast(isRecord) : undefined;
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
  { results: (body: JsonRecord) => JsonRecord[]; idField: string }
> = {
  "openai-chat": {
    results: (body) =>
      trailingRecords(body.messages, (message) => message.role === "tool"),
    idField: "tool_call_id",
  },
  "openai-responses": {
    results: (body) => trailingRecords(body.input, isClientToolOutput),
    idField: "call_id",
  },
  anthropic: {
    results: (body) => {
      const last = lastRecord(body.messages);
      return last?.role === "user"
        ? records(last.content).filter((block) => block.type === "tool_result")
        : [];
    },
    idField: "tool_use_id",
  },
};

export function trailingToolResultIds(
  shape: ApiProxyResponseShape,
  body: unknown,
): string[] | null {
  const record = asObject(body);
  const reader = trailingToolResultReaders[shape];
  const results = record ? reader.results(record) : [];
  if (results.length === 0) {
    return null;
  }
  return results
    .map((result) => nonEmptyString(result[reader.idField]))
    .filter((id): id is string => id !== null);
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

function isResponsesToolCall(item: JsonRecord): boolean {
  return nonEmptyString(item.call_id) !== null;
}

function responsesToolCallDelta(
  item: JsonRecord,
  index: number,
): ApiProxyResumableToolCallDelta {
  return toolCallDelta(
    index,
    item.call_id,
    item.name,
    item.arguments ?? item.input,
  );
}

export function responsesOutputItemToolCall(
  item: unknown,
  index: number,
): ApiProxyResumableToolCallDelta | null {
  const record = asObject(item);
  return record && isResponsesToolCall(record)
    ? responsesToolCallDelta(record, index)
    : null;
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
      .filter(isResponsesToolCall)
      .map((item, index) => responsesToolCallDelta(item, index)),
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
): ApiProxyResumableToolCallDelta[] {
  const record = asObject(body);
  return record ? responseToolCallReaders[shape](record) : [];
}
