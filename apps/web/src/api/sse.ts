import type { ApiProbeRequest } from "@arriero/core";

type ApiProbeStreamMeta = {
  kind: ApiProbeRequest["kind"];
  endpoint: string;
  requestBody: unknown;
};

type ApiProbeStreamStatus = {
  ok: boolean;
  status: number;
  latencyMs: number;
};

type ApiProbeStreamDone = {
  latencyMs: number;
  finishReason: string | null;
  usage: unknown;
  timings: unknown;
};

export type ApiProbeStreamCallbacks = {
  onMeta?: (meta: ApiProbeStreamMeta) => void;
  onStatus?: (status: ApiProbeStreamStatus) => void;
  onToken?: (token: string) => void;
  onDone?: (done: ApiProbeStreamDone) => void;
  onError?: (error: unknown) => void;
  onCancelled?: (payload: unknown) => void;
};

function parseSseBlock(block: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return { event, data: data.join("\n") };
}

function parseSseJson(data: string): unknown {
  if (!data) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

function dispatchApiProbeStreamEvent(
  block: string,
  callbacks: ApiProbeStreamCallbacks,
) {
  const parsed = parseSseBlock(block);
  if (!parsed.data) return;
  const payload = parseSseJson(parsed.data);

  switch (parsed.event) {
    case "meta":
      callbacks.onMeta?.(payload as ApiProbeStreamMeta);
      break;
    case "status":
      callbacks.onStatus?.(payload as ApiProbeStreamStatus);
      break;
    case "token": {
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : null;
      const token = typeof record?.text === "string" ? record.text : "";
      if (token) callbacks.onToken?.(token);
      break;
    }
    case "done":
      callbacks.onDone?.(payload as ApiProbeStreamDone);
      break;
    case "error":
      callbacks.onError?.(payload);
      break;
    case "cancelled":
      callbacks.onCancelled?.(payload);
      break;
    default:
      break;
  }
}

export async function readApiProbeStream(
  response: Response,
  callbacks: ApiProbeStreamCallbacks,
) {
  if (!response.body) {
    throw new Error("Streaming response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let separator = buffer.match(/\r?\n\r?\n/);
    while (separator && separator.index !== undefined) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      dispatchApiProbeStreamEvent(block, callbacks);
      separator = buffer.match(/\r?\n\r?\n/);
    }
  }

  if (buffer.trim()) {
    dispatchApiProbeStreamEvent(buffer, callbacks);
  }
}
