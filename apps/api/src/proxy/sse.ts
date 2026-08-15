export function sseDataPayloads(frame: string): string[] {
  const payloads: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (data) {
      payloads.push(data);
    }
  }
  return payloads;
}

export type SseFrameBuffer = {
  push: (chunk: Uint8Array) => string[];
  flush: () => string | null;
};

const FRAME_SEPARATOR = /\r?\n\r?\n/;

export function createSseFrameBuffer(): SseFrameBuffer {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      const frames: string[] = [];
      let separator = pending.match(FRAME_SEPARATOR);
      while (separator && separator.index !== undefined) {
        frames.push(pending.slice(0, separator.index));
        pending = pending.slice(separator.index + separator[0].length);
        separator = pending.match(FRAME_SEPARATOR);
      }
      return frames;
    },
    flush() {
      pending += decoder.decode();
      return pending.trim() ? pending : null;
    },
  };
}

export async function consumeSseEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (data: string) => Promise<boolean> | boolean,
): Promise<void> {
  const reader = stream.getReader();
  const frames = createSseFrameBuffer();
  const emitFrame = async (frame: string): Promise<boolean> => {
    for (const data of sseDataPayloads(frame)) {
      if (await onEvent(data)) {
        return true;
      }
    }
    return false;
  };
  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of frames.push(chunk.value)) {
        done = await emitFrame(frame);
        if (done) break;
      }
    }
    if (!done) {
      const tail = frames.flush();
      if (tail !== null) {
        await emitFrame(tail);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
