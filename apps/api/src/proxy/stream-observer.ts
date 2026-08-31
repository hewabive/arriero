import type { ApiProxyInflightHandle } from "./inflight.js";
import type {
  ApiProxyResumableStreamChunk,
  ApiProxyResumableToolCallDelta,
} from "./protocol.js";

export type ProxyPrefillProgress = NonNullable<
  ApiProxyResumableStreamChunk["promptProgress"]
>;

export type ProxyStreamObserver = {
  onFirstToken?: ((promptTokens: number | null) => void) | undefined;
  onResponseMetadata?:
    | ((metadata: { id: string | null; model: string | null }) => void)
    | undefined;
  onReasoning?: (() => void) | undefined;
  onReasoningDelta?: ((text: string) => void) | undefined;
  onAnswerDelta?: ((text: string) => void) | undefined;
  onToolCall?: ((delta: ApiProxyResumableToolCallDelta) => void) | undefined;
  onProgress?: ((completionTokens: number) => void) | undefined;
  onPrefillProgress?: ((progress: ProxyPrefillProgress) => void) | undefined;
};

export function inflightStreamObserver(
  inflight: ApiProxyInflightHandle,
  overrides: ProxyStreamObserver = {},
): ProxyStreamObserver {
  return {
    onFirstToken: (promptTokens) => inflight.firstToken(promptTokens),
    onReasoning: () => inflight.firstReasoning(),
    onReasoningDelta: (text) => inflight.appendReasoning(text),
    onAnswerDelta: (text) => inflight.appendAnswer(text),
    onToolCall: (delta) => inflight.appendToolCall(delta),
    onProgress: (completionTokens) =>
      inflight.setCompletionTokens(completionTokens),
    onPrefillProgress: (progress) => inflight.setPrefillProgress(progress),
    ...overrides,
  };
}

export type ProxyStreamUsageTally = {
  promptTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  completionTokens: number;
};

export function emptyProxyStreamUsageTally(): ProxyStreamUsageTally {
  return {
    promptTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 0,
  };
}

function tallyChunkUsage(
  tally: ProxyStreamUsageTally,
  usage: NonNullable<ApiProxyResumableStreamChunk["usage"]>,
): void {
  if (typeof usage.completionTokens === "number") {
    tally.completionTokens += usage.completionTokens;
  }
  if (tally.promptTokens === null && typeof usage.promptTokens === "number") {
    tally.promptTokens = usage.promptTokens;
  }
  if (
    tally.cacheReadTokens === null &&
    typeof usage.cacheReadTokens === "number"
  ) {
    tally.cacheReadTokens = usage.cacheReadTokens;
  }
  if (
    tally.cacheCreationTokens === null &&
    typeof usage.cacheCreationTokens === "number"
  ) {
    tally.cacheCreationTokens = usage.cacheCreationTokens;
  }
}

export function createProxyChunkObserver(
  observer: ProxyStreamObserver,
  usage: ProxyStreamUsageTally,
): (chunk: ApiProxyResumableStreamChunk) => void {
  let firstTokenSeen = false;
  let reasoningSeen = false;
  return (chunk) => {
    if (chunk.id !== null || chunk.model !== null) {
      observer.onResponseMetadata?.({ id: chunk.id, model: chunk.model });
    }
    if (chunk.promptProgress) {
      observer.onPrefillProgress?.(chunk.promptProgress);
    }
    if (chunk.usage) {
      tallyChunkUsage(usage, chunk.usage);
    }
    if (chunk.reasoning) {
      if (!reasoningSeen) {
        reasoningSeen = true;
        observer.onReasoning?.();
      }
      observer.onReasoningDelta?.(chunk.reasoning);
    }
    if (chunk.text !== "") {
      observer.onAnswerDelta?.(chunk.text);
    }
    if (
      !firstTokenSeen &&
      (chunk.text !== "" || (chunk.toolCalls?.length ?? 0) > 0)
    ) {
      firstTokenSeen = true;
      observer.onFirstToken?.(usage.promptTokens);
    }
    observer.onProgress?.(usage.completionTokens);
    for (const toolCall of chunk.toolCalls ?? []) {
      observer.onToolCall?.(toolCall);
    }
  };
}
