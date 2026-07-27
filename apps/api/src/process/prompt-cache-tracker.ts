import type { ProcessEvent, PromptCacheState } from "@arriero/core";
import { supervisor } from "./supervisor.js";

const CACHE_STATE_PATTERN =
  /- cache state:\s+(\d+)\s+prompts,\s+([0-9.]+)\s+MiB\s+\(limits:\s+([0-9.]+)\s+MiB/;

const MAX_BUFFER_BYTES = 64 * 1024;

export class PromptCacheTracker {
  private readonly latest = new Map<string, PromptCacheState>();
  private readonly buffers = new Map<string, string>();

  observe(event: ProcessEvent): void {
    if (event.type === "exit") {
      this.latest.delete(event.instanceId);
      this.buffers.delete(event.instanceId);
      return;
    }
    if (event.type !== "log") {
      return;
    }
    const buffered = (this.buffers.get(event.instanceId) ?? "") + event.message;
    const newlineAt = buffered.lastIndexOf("\n");
    if (newlineAt === -1) {
      this.buffers.set(
        event.instanceId,
        buffered.length > MAX_BUFFER_BYTES ? "" : buffered,
      );
      return;
    }
    const complete = buffered.slice(0, newlineAt);
    this.buffers.set(event.instanceId, buffered.slice(newlineAt + 1));
    for (const line of complete.split("\n")) {
      this.observeLine(event.instanceId, line, event.timestamp);
    }
  }

  private observeLine(instanceId: string, line: string, at: string): void {
    const match = CACHE_STATE_PATTERN.exec(line);
    if (!match) {
      return;
    }
    const prompts = Number(match[1]);
    const sizeMiB = Number(match[2]);
    const limitRaw = Number(match[3]);
    if (!Number.isFinite(prompts) || !Number.isFinite(sizeMiB)) {
      return;
    }
    this.latest.set(instanceId, {
      prompts,
      sizeMiB,
      limitMiB: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null,
      at,
    });
  }

  get(instanceId: string): PromptCacheState | null {
    return this.latest.get(instanceId) ?? null;
  }
}

export const promptCacheTracker = new PromptCacheTracker();

supervisor.on("event", (event: ProcessEvent) =>
  promptCacheTracker.observe(event),
);
