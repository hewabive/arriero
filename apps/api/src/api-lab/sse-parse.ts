import { asObject } from "../proxy/json.js";
import { errorBodyMessage } from "../proxy/protocol-trace.js";

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

export function streamErrorMessage(value: unknown): string | null {
  const record = asObject(value);
  if (!record) return null;
  if (typeof record.error === "string") return record.error;
  const error = asObject(record.error);
  if (!error) return null;
  return errorBodyMessage(record) ?? JSON.stringify(error);
}
