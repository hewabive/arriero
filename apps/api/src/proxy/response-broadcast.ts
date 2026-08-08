type Broadcast = {
  contentType: string;
  chunks: Uint8Array[];
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
  done: boolean;
};

const broadcasts = new Map<string, Broadcast>();

export function registerApiProxyBroadcast(
  key: string,
  contentType = "text/event-stream",
): void {
  if (broadcasts.has(key)) {
    return;
  }
  broadcasts.set(key, {
    contentType,
    chunks: [],
    subscribers: new Set(),
    done: false,
  });
}

export function pushApiProxyBroadcast(key: string, chunk: Uint8Array): void {
  const entry = broadcasts.get(key);
  if (!entry || entry.done) {
    return;
  }
  entry.chunks.push(chunk);
  for (const subscriber of entry.subscribers) {
    try {
      subscriber.enqueue(chunk);
    } catch {
      entry.subscribers.delete(subscriber);
    }
  }
}

export function finishApiProxyBroadcast(key: string): void {
  const entry = broadcasts.get(key);
  if (!entry) {
    return;
  }
  entry.done = true;
  broadcasts.delete(key);
  for (const subscriber of entry.subscribers) {
    try {
      subscriber.close();
    } catch {}
  }
  entry.subscribers.clear();
}

export function abortApiProxyBroadcast(key: string, message: string): void {
  const entry = broadcasts.get(key);
  if (!entry) {
    return;
  }
  entry.done = true;
  broadcasts.delete(key);
  const reason = new Error(message);
  for (const subscriber of entry.subscribers) {
    try {
      subscriber.error(reason);
    } catch {
      entry.subscribers.delete(subscriber);
    }
  }
  entry.subscribers.clear();
}

export function subscribeApiProxyBroadcast(
  key: string,
): { contentType: string; body: ReadableStream<Uint8Array> } | null {
  const entry = broadcasts.get(key);
  if (!entry || entry.done) {
    return null;
  }
  let ownController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ownController = controller;
      for (const chunk of entry.chunks) {
        controller.enqueue(chunk);
      }
      entry.subscribers.add(controller);
    },
    cancel() {
      if (ownController) {
        entry.subscribers.delete(ownController);
      }
    },
  });
  return { contentType: entry.contentType, body };
}

export function clearApiProxyBroadcasts(): void {
  for (const key of [...broadcasts.keys()]) {
    finishApiProxyBroadcast(key);
  }
}
