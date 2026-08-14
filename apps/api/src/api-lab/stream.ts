import type { ApiProbeRequest } from "@arriero/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { instanceApiProbeTarget } from "../llama/probe.js";
import { asObject } from "../proxy/json.js";
import { apiLabProbeTargetFromBaseUrl } from "./probe.js";
import {
  consumeSseEvents,
  streamDeltaText,
  streamFinishReason,
} from "./sse-parse.js";

export function isStreamingProbeKind(kind: string) {
  return (
    kind === "chat" ||
    kind === "completion" ||
    kind === "responses" ||
    kind === "infill"
  );
}

async function writeUpstreamStreamEvents(props: {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0];
  response: Response;
  started: number;
}) {
  const body = props.response.body;
  if (!body) {
    await props.stream.writeSSE({
      event: "error",
      data: JSON.stringify({ message: "upstream returned no stream body" }),
    });
    return null;
  }

  let finalBody: unknown = null;
  let finishReason: string | null = null;
  let usage: unknown = null;

  await consumeSseEvents(body, async (data) => {
    if (data === "[DONE]") return true;

    try {
      const parsed = JSON.parse(data) as unknown;
      finalBody = parsed;
      finishReason = streamFinishReason(parsed) ?? finishReason;
      usage = asObject(parsed)?.usage ?? usage;
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
  });

  const finalRecord = asObject(finalBody);
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
              asObject(asObject(body)?.error)?.message ?? response.statusText,
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
