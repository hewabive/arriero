import type { ApiProbeRequest } from "@arriero/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { instanceApiProbeTarget } from "../llama/probe.js";
import { apiLabProbeTargetFromBaseUrl } from "./probe.js";

export function isStreamingProbeKind(kind: string) {
  return (
    kind === "chat" ||
    kind === "completion" ||
    kind === "responses" ||
    kind === "infill"
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? recordValue(value[0]) : null;
}

function streamDeltaText(value: unknown) {
  const record = recordValue(value);
  if (!record) return "";

  if (typeof record.delta === "string") return record.delta;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.output_text === "string") return record.output_text;

  const choice = firstRecord(record.choices);
  const delta = recordValue(choice?.delta);
  const message = recordValue(choice?.message);
  const content =
    delta?.content ??
    delta?.reasoning_content ??
    delta?.text ??
    message?.content ??
    choice?.text;
  if (typeof content === "string") return content;

  if (record.type === "content_block_delta") {
    const anthropicDelta = recordValue(record.delta);
    if (typeof anthropicDelta?.text === "string") return anthropicDelta.text;
  }

  if (typeof record.type === "string" && record.type.endsWith(".delta")) {
    const deltaText = record.delta ?? record.text;
    if (typeof deltaText === "string") return deltaText;
  }

  return "";
}

function streamFinishReason(value: unknown) {
  const record = recordValue(value);
  const choice = firstRecord(record?.choices);
  const reason = choice?.finish_reason;
  if (typeof reason === "string") return reason;
  const anthropicStop =
    recordValue(record?.delta)?.stop_reason ?? record?.stop_reason;
  return typeof anthropicStop === "string" ? anthropicStop : null;
}

function streamEventData(block: string) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

async function writeUpstreamStreamEvents(props: {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0];
  response: Response;
  started: number;
}) {
  const reader = props.response.body?.getReader();
  if (!reader) {
    await props.stream.writeSSE({
      event: "error",
      data: JSON.stringify({ message: "upstream returned no stream body" }),
    });
    return null;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let finalBody: unknown = null;
  let finishReason: string | null = null;
  let usage: unknown = null;

  const consumeBlock = async (block: string) => {
    const data = streamEventData(block);
    if (!data) return false;
    if (data === "[DONE]") return true;

    try {
      const parsed = JSON.parse(data) as unknown;
      finalBody = parsed;
      finishReason = streamFinishReason(parsed) ?? finishReason;
      usage = recordValue(parsed)?.usage ?? usage;
      const delta = streamDeltaText(parsed);
      if (delta) {
        await props.stream.writeSSE({
          event: "token",
          data: JSON.stringify({ text: delta }),
        });
      }
    } catch {
      await props.stream.writeSSE({
        event: "token",
        data: JSON.stringify({ text: data }),
      });
    }

    return false;
  };

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
        done = await consumeBlock(block);
        if (done) break;
        separator = buffer.match(/\r?\n\r?\n/);
      }
    }

    if (buffer.trim()) {
      await consumeBlock(buffer);
    }

    const finalRecord = recordValue(finalBody);
    const latencyMs = Math.round(performance.now() - props.started);
    await props.stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        latencyMs,
        finishReason,
        usage: usage ?? finalRecord?.usage ?? null,
        timings: finalRecord?.timings ?? null,
      }),
    });
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function streamApiProbeTarget(
  c: Context,
  input: {
    request: ApiProbeRequest;
    headers?: Record<string, string> | undefined;
    target:
      | ReturnType<typeof instanceApiProbeTarget>
      | ReturnType<typeof apiLabProbeTargetFromBaseUrl>;
  },
) {
  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    await stream.writeSSE({
      event: "meta",
      data: JSON.stringify({
        kind: input.request.kind,
        endpoint: input.target.endpoint,
        requestBody: input.target.requestBody,
      }),
    });

    const started = performance.now();
    try {
      const response = await fetch(input.target.url, {
        method: "POST",
        body: JSON.stringify(input.target.requestBody),
        headers: { "content-type": "application/json", ...input.headers },
        signal: controller.signal,
      });

      await stream.writeSSE({
        event: "status",
        data: JSON.stringify({
          ok: response.ok,
          status: response.status,
          latencyMs: Math.round(performance.now() - started),
        }),
      });

      if (!response.ok) {
        const rawBody = await response.text();
        let body: unknown = rawBody;
        try {
          body = JSON.parse(rawBody) as unknown;
        } catch {
          body = rawBody;
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            status: response.status,
            body,
            message:
              recordValue(recordValue(body)?.error)?.message ??
              response.statusText,
          }),
        });
        return;
      }

      await writeUpstreamStreamEvents({
        stream,
        response,
        started,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await stream.writeSSE({
          event: "cancelled",
          data: JSON.stringify({
            latencyMs: Math.round(performance.now() - started),
          }),
        });
        return;
      }
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: (error as Error).message }),
      });
    }
  });
}
