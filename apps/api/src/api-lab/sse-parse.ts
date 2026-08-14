import { asObject } from "../proxy/json.js";

function firstRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? asObject(value[0]) : null;
}

export function streamDeltaText(value: unknown): string {
  const record = asObject(value);
  if (!record) return "";

  if (typeof record.delta === "string") return record.delta;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.output_text === "string") return record.output_text;

  const choice = firstRecord(record.choices);
  const delta = asObject(choice?.delta);
  const message = asObject(choice?.message);
  const content =
    delta?.content ??
    delta?.reasoning_content ??
    delta?.text ??
    message?.content ??
    choice?.text;
  if (typeof content === "string") return content;

  if (record.type === "content_block_delta") {
    const anthropicDelta = asObject(record.delta);
    if (typeof anthropicDelta?.text === "string") return anthropicDelta.text;
  }

  if (typeof record.type === "string" && record.type.endsWith(".delta")) {
    const deltaText = record.delta ?? record.text;
    if (typeof deltaText === "string") return deltaText;
  }

  return "";
}

export function streamFinishReason(value: unknown): string | null {
  const record = asObject(value);
  const choice = firstRecord(record?.choices);
  const reason = choice?.finish_reason;
  if (typeof reason === "string") return reason;
  const anthropicStop =
    asObject(record?.delta)?.stop_reason ?? record?.stop_reason;
  return typeof anthropicStop === "string" ? anthropicStop : null;
}

function streamEventData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

export async function consumeSseEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (data: string) => Promise<boolean> | boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let separator = buffer.match(/\r?\n\r?\n/);
      while (separator && separator.index !== undefined) {
        const separatorIndex = separator.index;
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + separator[0].length);
        const data = streamEventData(block);
        if (data) {
          done = await onEvent(data);
          if (done) break;
        }
        separator = buffer.match(/\r?\n\r?\n/);
      }
    }

    if (!done) {
      const data = streamEventData(buffer);
      if (data) {
        await onEvent(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
