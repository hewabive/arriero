import {
  CLIENT_ABORT_STATUS,
  describeFetchError,
  proxyUpstreamFetch,
} from "./http.js";
import type {
  ApiProxyResumableCodec,
  ApiProxyResumableFinalResponse,
  ApiProxyResumableToolCall,
  ApiProxyResumableToolCallDelta,
} from "./protocol.js";
import { createSseFrameBuffer, sseDataPayloads } from "./sse.js";
import {
  emptyProxyStreamHealth,
  noteMalformedPayload,
  type ProxyStreamHealth,
} from "./stream-health.js";
import { watchStreamIdle } from "./stream-idle.js";

export type ResumableBufferState = {
  text: string;
  reasoningText: string;
  id: string | null;
  model: string | null;
  finishReason: string | null;
  completionTokens: number;
  promptTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  genMs: number;
  toolCalls: ApiProxyResumableToolCall[];
  inToolPhase: boolean;
  health: ProxyStreamHealth;
};

export type ResumableUpstreamOutcome =
  | { type: "completed" }
  | { type: "truncated" }
  | { type: "preempted" }
  | { type: "interrupted" }
  | { type: "finished" }
  | { type: "cancelled" }
  | { type: "consumer-gone" }
  | { type: "error"; message: string };

export type ResumableTruncationPolicy = {
  mode: "resume" | "error" | "accept";
  maxRetries?: number | undefined;
};

const DEFAULT_TRUNCATION_RETRIES = 2;

export function createResumableBufferState(): ResumableBufferState {
  return {
    text: "",
    reasoningText: "",
    id: null,
    model: null,
    finishReason: null,
    completionTokens: 0,
    promptTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    genMs: 0,
    toolCalls: [],
    inToolPhase: false,
    health: emptyProxyStreamHealth(),
  };
}

type FrameMeta = {
  upstreamGenMs: number | null;
  firstTokenSeen: boolean;
  reasoningSeen: boolean;
  finishSeen: boolean;
  onFirstToken?: ((promptTokens: number | null) => void) | undefined;
  onReasoning?: (() => void) | undefined;
  onReasoningDelta?: ((text: string) => void) | undefined;
  onAnswerDelta?: ((text: string) => void) | undefined;
  onToolCall?: ((delta: ApiProxyResumableToolCallDelta) => void) | undefined;
  onProgress?: ((completionTokens: number) => void) | undefined;
  onPrefillProgress?:
    | ((progress: { total: number; processed: number; cache: number }) => void)
    | undefined;
};

function applyFrame(
  frame: string,
  codec: ApiProxyResumableCodec,
  state: ResumableBufferState,
  meta: FrameMeta,
): "done" | null {
  for (const data of sseDataPayloads(frame)) {
    const chunk = codec.parseChunk(data);
    if (chunk === "done") {
      return "done";
    }
    if (chunk === "malformed") {
      noteMalformedPayload(state.health, data);
      continue;
    }
    if (chunk === null) {
      continue;
    }
    state.text += chunk.text;
    if (chunk.text !== "") {
      meta.onAnswerDelta?.(chunk.text);
    }
    if (chunk.reasoning) {
      state.reasoningText += chunk.reasoning;
      meta.onReasoningDelta?.(chunk.reasoning);
    }
    if (chunk.id) {
      state.id = chunk.id;
    }
    if (chunk.model) {
      state.model = chunk.model;
    }
    if (chunk.finishReason) {
      state.finishReason = chunk.finishReason;
      meta.finishSeen = true;
    }
    if (typeof chunk.genMs === "number") {
      meta.upstreamGenMs = chunk.genMs;
    }
    if (chunk.promptProgress) {
      meta.onPrefillProgress?.(chunk.promptProgress);
    }
    if (chunk.phase === "tool") {
      state.inToolPhase = true;
    }
    if (chunk.toolCall) {
      const { index } = chunk.toolCall;
      const existing = state.toolCalls[index] ?? {
        id: null,
        name: null,
        arguments: "",
      };
      state.toolCalls[index] = {
        id: chunk.toolCall.id ?? existing.id,
        name: chunk.toolCall.name ?? existing.name,
        arguments: existing.arguments + (chunk.toolCall.arguments ?? ""),
      };
    }
    if (chunk.usage) {
      if (typeof chunk.usage.completionTokens === "number") {
        state.completionTokens += chunk.usage.completionTokens;
      }
      if (
        state.promptTokens === null &&
        typeof chunk.usage.promptTokens === "number"
      ) {
        state.promptTokens = chunk.usage.promptTokens;
      }
      if (
        state.cacheReadTokens === null &&
        typeof chunk.usage.cacheReadTokens === "number"
      ) {
        state.cacheReadTokens = chunk.usage.cacheReadTokens;
      }
      if (
        state.cacheCreationTokens === null &&
        typeof chunk.usage.cacheCreationTokens === "number"
      ) {
        state.cacheCreationTokens = chunk.usage.cacheCreationTokens;
      }
    }
    if (!meta.reasoningSeen && chunk.reasoning) {
      meta.reasoningSeen = true;
      meta.onReasoning?.();
    }
    if (!meta.firstTokenSeen && (chunk.text !== "" || chunk.toolCall)) {
      meta.firstTokenSeen = true;
      meta.onFirstToken?.(state.promptTokens);
    }
    meta.onProgress?.(state.completionTokens);
    if (chunk.toolCall) {
      meta.onToolCall?.(chunk.toolCall);
    }
  }
  return null;
}

async function pumpSseFrames(
  body: ReadableStream<Uint8Array>,
  codec: ApiProxyResumableCodec,
  state: ResumableBufferState,
  meta: FrameMeta,
): Promise<"done" | "eof"> {
  const reader = body.getReader();
  const frames = createSseFrameBuffer();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    for (const frame of frames.push(value)) {
      if (applyFrame(frame, codec, state, meta) === "done") {
        return "done";
      }
    }
  }
  const tail = frames.flush();
  if (tail && applyFrame(tail, codec, state, meta) === "done") {
    return "done";
  }
  return "eof";
}

function classifyStreamEnding(
  ending: "done" | "eof",
  meta: FrameMeta,
  state: ResumableBufferState,
): "completed" | "truncated" {
  if (ending === "done") {
    state.health.terminal = "done";
    return "completed";
  }
  if (meta.finishSeen) {
    state.health.terminal = "finish";
    return "completed";
  }
  state.health.terminal = "eof";
  return "truncated";
}

export async function runResumableUpstreamAttempt(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  codec: ApiProxyResumableCodec;
  state: ResumableBufferState;
  preemptSignal: AbortSignal;
  consumerSignal?: AbortSignal | undefined;
  interruptSignal?: AbortSignal | undefined;
  finishSignal?: AbortSignal | undefined;
  cancelSignal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
  idleTimeoutMs?: number | null | undefined;
  onFirstToken?: ((promptTokens: number | null) => void) | undefined;
  onReasoning?: (() => void) | undefined;
  onReasoningDelta?: ((text: string) => void) | undefined;
  onAnswerDelta?: ((text: string) => void) | undefined;
  onToolCall?: ((delta: ApiProxyResumableToolCallDelta) => void) | undefined;
  onProgress?: ((completionTokens: number) => void) | undefined;
  onPrefillProgress?:
    | ((progress: { total: number; processed: number; cache: number }) => void)
    | undefined;
}): Promise<ResumableUpstreamOutcome> {
  const {
    preemptSignal,
    consumerSignal,
    interruptSignal,
    finishSignal,
    cancelSignal,
  } = input;
  if (consumerSignal?.aborted) {
    return { type: "consumer-gone" };
  }
  if (cancelSignal?.aborted) {
    return { type: "cancelled" };
  }
  if (finishSignal?.aborted) {
    return { type: "finished" };
  }
  if (interruptSignal?.aborted) {
    return { type: "interrupted" };
  }
  if (preemptSignal.aborted) {
    return { type: "preempted" };
  }

  const fetchImpl = input.fetchImpl ?? proxyUpstreamFetch;
  const meta: FrameMeta = {
    upstreamGenMs: null,
    firstTokenSeen: false,
    reasoningSeen: false,
    finishSeen: false,
    onFirstToken: input.onFirstToken,
    onReasoning: input.onReasoning,
    onReasoningDelta: input.onReasoningDelta,
    onAnswerDelta: input.onAnswerDelta,
    onToolCall: input.onToolCall,
    onProgress: input.onProgress,
    onPrefillProgress: input.onPrefillProgress,
  };
  const controller = new AbortController();
  const onPreempt = () => {
    if (!input.state.inToolPhase) {
      controller.abort();
    }
  };
  const onConsumerGone = () => controller.abort();
  const onInterrupt = () => controller.abort();
  const onFinish = () => controller.abort();
  const onCancel = () => controller.abort();
  preemptSignal.addEventListener("abort", onPreempt, { once: true });
  consumerSignal?.addEventListener("abort", onConsumerGone, { once: true });
  interruptSignal?.addEventListener("abort", onInterrupt, { once: true });
  finishSignal?.addEventListener("abort", onFinish, { once: true });
  cancelSignal?.addEventListener("abort", onCancel, { once: true });

  const settle = (
    outcome: ResumableUpstreamOutcome,
  ): ResumableUpstreamOutcome => {
    preemptSignal.removeEventListener("abort", onPreempt);
    consumerSignal?.removeEventListener("abort", onConsumerGone);
    interruptSignal?.removeEventListener("abort", onInterrupt);
    finishSignal?.removeEventListener("abort", onFinish);
    cancelSignal?.removeEventListener("abort", onCancel);
    if (meta.upstreamGenMs !== null) {
      input.state.genMs += Math.max(0, meta.upstreamGenMs);
    }
    return outcome;
  };

  const classifyAbort = (error: unknown): ResumableUpstreamOutcome => {
    if (consumerSignal?.aborted) {
      return { type: "consumer-gone" };
    }
    if (cancelSignal?.aborted) {
      return { type: "cancelled" };
    }
    if (finishSignal?.aborted) {
      return { type: "finished" };
    }
    if (interruptSignal?.aborted) {
      return { type: "interrupted" };
    }
    if (preemptSignal.aborted) {
      return { type: "preempted" };
    }
    return { type: "error", message: describeFetchError(error) };
  };

  let upstream: Response;
  try {
    upstream = await fetchImpl(input.url, {
      method: input.method,
      headers: { "content-type": "application/json", ...input.headers },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
  } catch (error) {
    return settle(classifyAbort(error));
  }

  if (!upstream.ok || !upstream.body) {
    return settle({
      type: "error",
      message: `upstream responded ${upstream.status}`,
    });
  }

  try {
    const ending = await pumpSseFrames(
      watchStreamIdle(upstream.body, input.idleTimeoutMs ?? null),
      input.codec,
      input.state,
      meta,
    );
    return settle({ type: classifyStreamEnding(ending, meta, input.state) });
  } catch (error) {
    return settle(classifyAbort(error));
  }
}

export type ConsumeResumableSseOutcome =
  | { type: "completed" }
  | { type: "truncated" }
  | { type: "finished" }
  | { type: "cancelled" }
  | { type: "consumer-gone" }
  | { type: "error"; message: string };

export async function consumeResumableSse(input: {
  body: ReadableStream<Uint8Array>;
  codec: ApiProxyResumableCodec;
  state: ResumableBufferState;
  consumerSignal?: AbortSignal | undefined;
  finishSignal?: AbortSignal | undefined;
  cancelSignal?: AbortSignal | undefined;
  idleTimeoutMs?: number | null | undefined;
  onFirstToken?: ((promptTokens: number | null) => void) | undefined;
  onReasoning?: (() => void) | undefined;
  onReasoningDelta?: ((text: string) => void) | undefined;
  onAnswerDelta?: ((text: string) => void) | undefined;
  onToolCall?: ((delta: ApiProxyResumableToolCallDelta) => void) | undefined;
  onProgress?: ((completionTokens: number) => void) | undefined;
  onPrefillProgress?:
    | ((progress: { total: number; processed: number; cache: number }) => void)
    | undefined;
}): Promise<ConsumeResumableSseOutcome> {
  const meta: FrameMeta = {
    upstreamGenMs: null,
    firstTokenSeen: false,
    reasoningSeen: false,
    finishSeen: false,
    onFirstToken: input.onFirstToken,
    onReasoning: input.onReasoning,
    onReasoningDelta: input.onReasoningDelta,
    onAnswerDelta: input.onAnswerDelta,
    onToolCall: input.onToolCall,
    onProgress: input.onProgress,
    onPrefillProgress: input.onPrefillProgress,
  };
  const classifyStop = (): ConsumeResumableSseOutcome | null => {
    if (input.consumerSignal?.aborted) {
      return { type: "consumer-gone" };
    }
    if (input.cancelSignal?.aborted) {
      return { type: "cancelled" };
    }
    if (input.finishSignal?.aborted) {
      return { type: "finished" };
    }
    return null;
  };
  const pending = classifyStop();
  if (pending) {
    return pending;
  }
  try {
    const ending = await pumpSseFrames(
      watchStreamIdle(input.body, input.idleTimeoutMs ?? null),
      input.codec,
      input.state,
      meta,
    );
    if (meta.upstreamGenMs !== null) {
      input.state.genMs += Math.max(0, meta.upstreamGenMs);
    }
    return { type: classifyStreamEnding(ending, meta, input.state) };
  } catch (error) {
    return (
      classifyStop() ?? { type: "error", message: describeFetchError(error) }
    );
  }
}

export function finalFromState(
  codec: ApiProxyResumableCodec,
  state: ResumableBufferState,
  wantsStream: boolean,
): ApiProxyResumableFinalResponse {
  return codec.finalResponse({
    text: state.text,
    reasoningText: state.reasoningText,
    id: state.id,
    model: state.model,
    finishReason: state.finishReason,
    wantsStream,
    completionTokens: state.completionTokens,
    promptTokens: state.promptTokens,
    genMs: state.genMs,
    toolCalls: state.toolCalls.filter(
      (call): call is ApiProxyResumableToolCall => Boolean(call),
    ),
  });
}

export async function runResumableForward(input: {
  makeReady: () => Promise<
    { ok: true } | { ok: false; final: ApiProxyResumableFinalResponse }
  >;
  attempt: (tail: string | null) => Promise<ResumableUpstreamOutcome>;
  state: ResumableBufferState;
  codec: ApiProxyResumableCodec;
  yieldLease: () => Promise<void>;
  wantsStream: boolean;
  onError: (message: string) => ApiProxyResumableFinalResponse;
  buildForceAnswerTail?: ((reasoningText: string) => string | null) | undefined;
  maxAttempts?: number | undefined;
  truncation?: ResumableTruncationPolicy | undefined;
}): Promise<ApiProxyResumableFinalResponse> {
  const maxAttempts = input.maxAttempts ?? 8;
  const truncation = input.truncation ?? { mode: "accept" };
  let preemptions = 0;
  let truncationRetries = 0;
  let forceAnswerNext = false;
  let forceAnswerPrefix: string | null = null;

  for (;;) {
    const ready = await input.makeReady();
    if (!ready.ok) {
      return ready.final;
    }

    let tail: string | null;
    if (forceAnswerNext) {
      forceAnswerPrefix =
        input.buildForceAnswerTail?.(input.state.reasoningText) ?? null;
      tail = forceAnswerPrefix;
      forceAnswerNext = false;
    } else if (forceAnswerPrefix !== null) {
      tail = forceAnswerPrefix + input.state.text;
    } else {
      tail =
        (preemptions === 0 && truncationRetries === 0) ||
        input.state.text.length === 0
          ? null
          : input.state.text;
      if (tail === null) {
        input.state.reasoningText = "";
      }
    }
    const outcome = await input.attempt(tail);

    if (outcome.type === "completed" || outcome.type === "finished") {
      return finalFromState(input.codec, input.state, input.wantsStream);
    }
    if (outcome.type === "truncated") {
      if (truncation.mode === "accept") {
        return finalFromState(input.codec, input.state, input.wantsStream);
      }
      if (
        truncation.mode === "error" ||
        truncationRetries >=
          (truncation.maxRetries ?? DEFAULT_TRUNCATION_RETRIES)
      ) {
        return input.onError(
          `upstream stream ended without a terminal chunk (${input.state.text.length} chars buffered, ${truncationRetries} resume retries)`,
        );
      }
      truncationRetries += 1;
      input.state.health.truncationRetries = truncationRetries;
      continue;
    }
    if (outcome.type === "consumer-gone" || outcome.type === "cancelled") {
      return { status: CLIENT_ABORT_STATUS, headers: {}, body: "" };
    }
    if (outcome.type === "error") {
      return input.onError(outcome.message);
    }
    if (outcome.type === "interrupted") {
      forceAnswerNext = true;
      continue;
    }

    preemptions += 1;
    if (preemptions >= maxAttempts) {
      return finalFromState(input.codec, input.state, input.wantsStream);
    }
    await input.yieldLease();
  }
}
