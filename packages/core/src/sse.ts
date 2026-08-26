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
