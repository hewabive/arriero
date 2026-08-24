export class StreamIdleTimeoutError extends Error {
  constructor(idleTimeoutMs: number) {
    super(
      `upstream stream stalled: no data received for ${Math.round(idleTimeoutMs / 1000)}s`,
    );
    this.name = "StreamIdleTimeoutError";
  }
}

export function watchStreamIdle(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number | null,
  onTimeout?: (error: StreamIdleTimeoutError) => void,
): ReadableStream<Uint8Array> {
  if (idleTimeoutMs === null) {
    return body;
  }
  const reader = body.getReader();
  let timer: NodeJS.Timeout | null = null;
  let settled = false;
  let lastReadAt = 0;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const settle = () => {
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (delayMs: number) => {
    timer = setTimeout(checkIdle, delayMs);
    timer.unref();
  };
  const checkIdle = () => {
    if (settled) {
      return;
    }
    const idleMs = performance.now() - lastReadAt;
    if (idleMs < idleTimeoutMs) {
      schedule(idleTimeoutMs - idleMs);
      return;
    }
    settle();
    const error = new StreamIdleTimeoutError(idleTimeoutMs);
    onTimeout?.(error);
    controllerRef?.error(error);
    void reader.cancel(error).catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      lastReadAt = performance.now();
      schedule(idleTimeoutMs);
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (!settled) {
          settle();
          controller.error(error);
        }
        return;
      }
      if (settled) {
        return;
      }
      if (result.done) {
        settle();
        controller.close();
        return;
      }
      lastReadAt = performance.now();
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      settle();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
