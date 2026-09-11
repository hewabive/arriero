import { asObject, type JsonRecord } from "./json.js";
import {
  apiProxyResponseShape,
  type ApiProxyProtocolOperation,
  type ApiProxyResponseShape,
} from "./protocol.js";
import { safeJsonParse } from "./protocol-trace.js";
import { transformApiProxySseText } from "./response-codec.js";

type CapturedEvent = { event: string | null; data: unknown };

function captureEvents(text: string): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  transformApiProxySseText(text, {
    transform(frame) {
      const lines = frame.split(/\r\n|\r|\n/);
      const data = lines.flatMap((line) => {
        const match = /^\uFEFF?[\t ]*data[\t ]*:[\t ]?(.*)$/.exec(line);
        return match ? [match[1] ?? ""] : [];
      });
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() ?? null;
      if (data.length > 0) {
        const joined = data.join("\n");
        if (joined.trim() !== "[DONE]") {
          const parsed = safeJsonParse(joined);
          if (parsed !== null || joined.trim() === "null") {
            events.push({ event, data: parsed });
          } else {
            for (const line of data) {
              if (line.trim() !== "[DONE]") {
                events.push({ event, data: safeJsonParse(line) ?? line });
              }
            }
          }
        }
      }
      return null;
    },
  });
  return events;
}

function appendDelta(target: JsonRecord, delta: JsonRecord): void {
  for (const [key, value] of Object.entries(delta)) {
    if (value === null && target[key] !== undefined) {
      continue;
    }
    const previous = Object.hasOwn(target, key) ? target[key] : undefined;
    let next = value;
    if (typeof value === "string" && key !== "role" && key !== "type") {
      next = (typeof previous === "string" ? previous : "") + value;
    } else if (Array.isArray(value)) {
      const entries: unknown[] = Array.isArray(previous) ? previous : [];
      next = entries;
      for (const item of value) {
        const record = asObject(item);
        if (record && typeof record.index === "number") {
          let entry = entries.find(
            (item) => asObject(item)?.index === record.index,
          );
          if (!asObject(entry)) {
            entry = { index: record.index };
            entries.push(entry);
          }
          appendDelta(asObject(entry)!, record);
        } else {
          entries.push(item);
        }
      }
    } else if (asObject(value)) {
      const nested = asObject(previous) ?? {};
      next = nested;
      appendDelta(nested, asObject(value)!);
    }
    Object.defineProperty(target, key, {
      value: next,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function captureOpenAiChat(events: CapturedEvent[]): JsonRecord | null {
  const response: JsonRecord = {};
  const choices = new Map<number, JsonRecord>();
  let recognized = false;
  for (const { data } of events) {
    const chunk = asObject(data);
    if (!chunk || (!Array.isArray(chunk.choices) && !chunk.error)) {
      return null;
    }
    recognized = true;
    const { choices: deltas, ...metadata } = chunk;
    Object.assign(response, metadata);
    if (!Array.isArray(deltas)) {
      continue;
    }
    for (const [position, value] of deltas.entries()) {
      const delta = asObject(value);
      if (!delta) {
        return null;
      }
      const index = typeof delta.index === "number" ? delta.index : position;
      const choice = choices.get(index) ?? { index };
      choices.set(index, choice);
      const { delta: messageDelta, text, logprobs, ...fields } = delta;
      Object.assign(choice, fields);
      if (asObject(messageDelta)) {
        const message = asObject(choice.message) ?? { role: "assistant" };
        choice.message = message;
        appendDelta(message, asObject(messageDelta)!);
      }
      if (typeof text === "string") {
        appendDelta(choice, { text });
      }
      if (logprobs !== undefined) {
        appendDelta(choice, { logprobs });
      }
    }
  }
  if (!recognized) {
    return null;
  }
  if (choices.size > 0) {
    response.choices = [...choices.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, choice]) => {
        const tools = asObject(choice.message)?.tool_calls;
        if (Array.isArray(tools)) {
          tools.sort(
            (left, right) =>
              Number(asObject(left)?.index) - Number(asObject(right)?.index),
          );
          for (const tool of tools) {
            const record = asObject(tool);
            if (record) delete record.index;
          }
        }
        return choice;
      });
  }
  if (response.object === "chat.completion.chunk") {
    response.object = "chat.completion";
  }
  return response;
}

function captureAnthropic(events: CapturedEvent[]): JsonRecord | null {
  let response: JsonRecord | null = null;
  const blocks = new Map<number, JsonRecord>();
  const inputs = new Map<number, string>();
  for (const { event, data } of events) {
    const value = asObject(data);
    if (!value) return null;
    const type = value.type ?? event;
    if (type === "message_start") {
      response = asObject(value.message);
      if (!response) return null;
      if (Array.isArray(response.content)) {
        for (const [index, block] of response.content.entries()) {
          const record = asObject(block);
          if (!record) return null;
          blocks.set(index, record);
        }
      }
    } else if (type === "content_block_start") {
      const block = asObject(value.content_block);
      if (!block || typeof value.index !== "number") return null;
      blocks.set(value.index, block);
    } else if (type === "content_block_delta") {
      const delta = asObject(value.delta);
      const index = value.index;
      const block = typeof index === "number" ? blocks.get(index) : null;
      if (!delta || !block || typeof index !== "number") return null;
      if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        inputs.set(index, (inputs.get(index) ?? "") + delta.partial_json);
      } else if (delta.type === "citations_delta") {
        appendDelta(block, { citations: [delta.citation] });
      } else {
        const { type: deltaType, ...fields } = delta;
        if (
          !["text_delta", "thinking_delta", "signature_delta"].includes(
            String(deltaType),
          )
        )
          return null;
        appendDelta(block, fields);
      }
    } else if (type === "message_delta") {
      if (!response) return null;
      Object.assign(response, asObject(value.delta));
      if (asObject(value.usage)) {
        response.usage = {
          ...asObject(response.usage),
          ...asObject(value.usage),
        };
      }
    } else if (type === "error") {
      response = Object.assign(response ?? {}, value);
    } else if (
      !["ping", "content_block_stop", "message_stop"].includes(String(type))
    ) {
      return null;
    }
  }
  if (!response) return null;
  for (const [index, text] of inputs) {
    const block = blocks.get(index);
    const input = safeJsonParse(text);
    if (!block || !asObject(input)) return null;
    block.input = input;
  }
  if (blocks.size > 0 || Array.isArray(response.content)) {
    response.content = [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block);
  }
  return response;
}

function captureOpenAiResponses(events: CapturedEvent[]): JsonRecord | null {
  if (
    events.some(({ event, data }) => {
      const value = asObject(data);
      return !value || !String(value.type ?? event).startsWith("response.");
    })
  )
    return null;
  for (const { event, data } of events.toReversed()) {
    const value = asObject(data);
    if (
      ["response.completed", "response.failed", "response.incomplete"].includes(
        String(value?.type ?? event),
      )
    ) {
      return asObject(value?.response);
    }
  }
  return null;
}

const captureByShape: Record<
  ApiProxyResponseShape,
  (events: CapturedEvent[]) => JsonRecord | null
> = {
  "openai-chat": captureOpenAiChat,
  anthropic: captureAnthropic,
  "openai-responses": captureOpenAiResponses,
};

export function captureApiProxyResponseSse(
  text: string,
  operation: ApiProxyProtocolOperation,
): unknown {
  const events = captureEvents(text);
  return (
    captureByShape[apiProxyResponseShape(operation)](
      structuredClone(events),
    ) ?? { events }
  );
}
