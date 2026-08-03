type ApiProxyJsonMutation = {
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

type ApiProxySseFrameSplit = {
  frames: string[];
  tail: string | null;
};

const sseFrameTerminator = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/;

function splitApiProxySseFrames(text: string): ApiProxySseFrameSplit {
  const frames: string[] = [];
  let pending = text;
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
  return { frames, tail: pending.length > 0 ? pending : null };
}

export type ApiProxySseFrameBuffer = {
  push: (chunk: Uint8Array) => string[];
  flush: () => string | null;
};

export function createApiProxySseFrameBuffer(): ApiProxySseFrameBuffer {
  const decoder = new TextDecoder();
  let pending = "";
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      const split = splitApiProxySseFrames(pending);
      pending = split.tail ?? "";
      return split.frames;
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

type ApiProxySseJsonPayload = {
  value: unknown;
  replace: (next: unknown) => void;
};

export type ApiProxyParsedSseJsonFrame = {
  payloads: ApiProxySseJsonPayload[];
  hasDone: boolean;
  serialize: () => ApiProxyTextMutation;
};

type ParsedSsePayload = ApiProxySseJsonPayload & {
  lineIndex: number;
  prefix: string;
  changed: boolean;
};

export function parseApiProxySseJsonFrame(
  frame: string,
): ApiProxyParsedSseJsonFrame {
  const lines = splitSseLines(frame);
  const parsed: ParsedSsePayload[] = [];
  let hasDone = false;
  for (const [lineIndex, line] of lines.entries()) {
    const match = sseDataLine.exec(line.content);
    if (!match) {
      continue;
    }
    const text = match[2] ?? "";
    if (!text) {
      continue;
    }
    if (text.trim() === "[DONE]") {
      hasDone = true;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    const payload: ParsedSsePayload = {
      value,
      lineIndex,
      prefix: match[1] ?? "",
      changed: false,
      replace: (next) => {
        payload.value = next;
        payload.changed = true;
      },
    };
    parsed.push(payload);
  }
  const serialize = (): ApiProxyTextMutation => {
    const rendered = new Map<number, string>();
    for (const payload of parsed) {
      if (!payload.changed) {
        continue;
      }
      try {
        rendered.set(
          payload.lineIndex,
          `${payload.prefix}${JSON.stringify(payload.value)}`,
        );
      } catch {
        continue;
      }
    }
    if (rendered.size === 0) {
      return { changed: false, text: frame };
    }
    let text = "";
    for (const [lineIndex, line] of lines.entries()) {
      text += `${rendered.get(lineIndex) ?? line.content}${line.ending}`;
    }
    return { changed: true, text };
  };
  return { payloads: parsed, hasDone, serialize };
}

export function mutateApiProxySseJsonFrame(
  frame: string,
  mutate: ApiProxyJsonMutator,
): ApiProxyTextMutation {
  const parsed = parseApiProxySseJsonFrame(frame);
  for (const payload of parsed.payloads) {
    const mutation = mutate(payload.value);
    if (mutation.changed) {
      payload.replace(mutation.value);
    }
  }
  return parsed.serialize();
}

export type ApiProxySseFrameTransformer = {
  transform: (frame: string) => string | string[] | null;
  flush?: (() => string | string[] | null) | undefined;
};

export function transformApiProxySseText(
  text: string,
  transformer: ApiProxySseFrameTransformer,
): string {
  const split = splitApiProxySseFrames(text);
  const output: string[] = [];
  const append = (value: string | string[] | null) => {
    if (value === null) {
      return;
    }
    output.push(...(Array.isArray(value) ? value : [value]));
  };
  for (const frame of split.frames) {
    append(transformer.transform(frame));
  }
  if (split.tail !== null) {
    append(transformer.transform(split.tail));
  }
  if (transformer.flush) {
    append(transformer.flush());
  }
  return output.join("");
}

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
