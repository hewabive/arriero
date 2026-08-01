export type ApiProxyJsonMutation = {
  changed: boolean;
  value: unknown;
};

export type ApiProxyJsonMutator = (value: unknown) => ApiProxyJsonMutation;

export type ApiProxyTextMutation = {
  changed: boolean;
  text: string;
};

export function mutateApiProxyJsonText(
  text: string,
  mutate: ApiProxyJsonMutator,
): ApiProxyTextMutation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { changed: false, text };
  }
  const mutation = mutate(parsed);
  if (!mutation.changed) {
    return { changed: false, text };
  }
  try {
    return { changed: true, text: JSON.stringify(mutation.value) };
  } catch {
    return { changed: false, text };
  }
}

export type ApiProxySseFrameBuffer = {
  push: (chunk: Uint8Array) => string[];
  flush: () => string | null;
};

const sseFrameTerminator = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/;

export function createApiProxySseFrameBuffer(): ApiProxySseFrameBuffer {
  const decoder = new TextDecoder();
  let pending = "";

  const takeFrames = () => {
    const frames: string[] = [];
    let match = sseFrameTerminator.exec(pending);
    while (match?.index !== undefined) {
      const end = match.index + match[0].length;
      if (end === pending.length && match[0].endsWith("\r")) {
        break;
      }
      frames.push(pending.slice(0, end));
      pending = pending.slice(end);
      match = sseFrameTerminator.exec(pending);
    }
    return frames;
  };

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      return takeFrames();
    },
    flush() {
      pending += decoder.decode();
      if (pending.length === 0) {
        return null;
      }
      const tail = pending;
      pending = "";
      return tail;
    },
  };
}

type SseLine = {
  content: string;
  ending: string;
};

function splitSseLines(frame: string): SseLine[] {
  const lines: SseLine[] = [];
  let start = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const char = frame[index];
    if (char !== "\r" && char !== "\n") {
      continue;
    }
    let ending = char;
    if (char === "\r" && frame[index + 1] === "\n") {
      ending = "\r\n";
      index += 1;
    }
    const contentEnd = index + 1 - ending.length;
    lines.push({ content: frame.slice(start, contentEnd), ending });
    start = index + 1;
  }
  if (start < frame.length) {
    lines.push({ content: frame.slice(start), ending: "" });
  }
  return lines;
}

const sseDataLine = /^(\uFEFF?[\t ]*data[\t ]*:[\t ]*)(.*)$/s;

export function mutateApiProxySseJsonFrame(
  frame: string,
  mutate: ApiProxyJsonMutator,
): ApiProxyTextMutation {
  let changed = false;
  const text = splitSseLines(frame)
    .map((line) => {
      const match = sseDataLine.exec(line.content);
      if (!match) {
        return `${line.content}${line.ending}`;
      }
      const prefix = match[1] ?? "";
      const payload = match[2] ?? "";
      if (!payload || payload.trim() === "[DONE]") {
        return `${line.content}${line.ending}`;
      }
      const mutation = mutateApiProxyJsonText(payload, mutate);
      if (!mutation.changed) {
        return `${line.content}${line.ending}`;
      }
      changed = true;
      return `${prefix}${mutation.text}${line.ending}`;
    })
    .join("");
  return changed ? { changed: true, text } : { changed: false, text: frame };
}

export function mutateApiProxySseJsonText(
  text: string,
  mutate: ApiProxyJsonMutator,
): ApiProxyTextMutation {
  const frames = createApiProxySseFrameBuffer();
  const output: string[] = [];
  let changed = false;
  const append = (frame: string) => {
    const mutation = mutateApiProxySseJsonFrame(frame, mutate);
    changed ||= mutation.changed;
    output.push(mutation.text);
  };
  for (const frame of frames.push(new TextEncoder().encode(text))) {
    append(frame);
  }
  const tail = frames.flush();
  if (tail !== null) {
    append(tail);
  }
  return changed ? { changed: true, text: output.join("") } : { changed, text };
}

export type ApiProxySseFrameTransformer = {
  transform: (frame: string) => string | string[] | null;
  flush?: (() => string | string[] | null) | undefined;
};

function enqueueText(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  output: string | string[] | null,
): void {
  if (output === null) {
    return;
  }
  for (const text of Array.isArray(output) ? output : [output]) {
    if (text.length > 0) {
      controller.enqueue(encoder.encode(text));
    }
  }
}

export function createApiProxySseTransform(
  transformer: ApiProxySseFrameTransformer,
): TransformStream<Uint8Array, Uint8Array> {
  const frames = createApiProxySseFrameBuffer();
  const encoder = new TextEncoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const frame of frames.push(chunk)) {
        enqueueText(controller, encoder, transformer.transform(frame));
      }
    },
    flush(controller) {
      const tail = frames.flush();
      if (tail !== null) {
        enqueueText(controller, encoder, transformer.transform(tail));
      }
      if (transformer.flush) {
        enqueueText(controller, encoder, transformer.flush());
      }
    },
  });
}
