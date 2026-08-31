import type {
  ApiProxyInflightControlAction,
  ApiProxyInflightControlAvailability,
  ApiProxyInflightControlResult,
  ApiProxyInflightControls,
  ApiProxyInflightControlUnavailableReason,
  ApiProxyInflightDetail,
  ApiProxyInflightPhase,
  ApiProxyInflightRequest,
} from "@arriero/core";

import { newId } from "../utils/id.js";

type InflightEntry = {
  id: string;
  originId: string | null;
  targetId: string | null;
  modelId: string;
  sourceId: string | null;
  sourceName: string | null;
  protocol: "openai" | "anthropic";
  stream: boolean;
  phase: ApiProxyInflightPhase;
  enqueuedAt: number;
  dispatchedAt: number | null;
  reasoningStartedAt: number | null;
  firstTokenAt: number | null;
  lastProgressAt: number;
  promptTokens: number | null;
  completionTokens: number;
  prefillTotalTokens: number | null;
  prefillProcessedTokens: number | null;
  prefillCachedTokens: number | null;
  reasoningText: string;
  reasoningCharsTotal: number;
  answerText: string;
  answerCharsTotal: number;
  toolCalls: { id: string | null; name: string | null; arguments: string }[];
  controlHandlers: Partial<
    Record<ApiProxyInflightControlAction, ApiProxyInflightControlHandler>
  >;
  controlControllers: Partial<
    Record<ApiProxyInflightControlAction, AbortController>
  >;
  endedAt: number | null;
};

const DEFAULT_INFLIGHT_STALE_AFTER_MS = 90 * 60 * 1000;
const DEFAULT_INFLIGHT_ENDED_RETAIN_MS = 15 * 1000;
const REASONING_BUFFER_CAP = 256 * 1024;
const ANSWER_BUFFER_CAP = 64 * 1024;
const TOOL_ARGS_BUFFER_CAP = 16 * 1024;

function appendCapped(buffer: string, addition: string, cap: number): string {
  if (addition.length === 0) {
    return buffer;
  }
  const next = buffer + addition;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

type ApiProxyInflightControlHandler = {
  unavailableReason?: () => ApiProxyInflightControlUnavailableReason | null;
  execute: () =>
    | void
    | ApiProxyInflightControlResult
    | Promise<void | ApiProxyInflightControlResult>;
};

function controlKey(
  action: ApiProxyInflightControlAction,
): keyof ApiProxyInflightControls {
  if (action === "force-answer") {
    return "forceAnswer";
  }
  return action;
}

function controlAvailability(
  entry: InflightEntry,
  action: ApiProxyInflightControlAction,
): ApiProxyInflightControlAvailability {
  if (entry.endedAt !== null) {
    return { available: false, reason: "request-finished" };
  }
  const handler = entry.controlHandlers[action];
  if (!handler) {
    return { available: false, reason: "not-supported" };
  }
  if (action === "force-answer") {
    if (entry.phase === "queued" || entry.phase === "prefilling") {
      return { available: false, reason: "not-ready" };
    }
    if (entry.phase !== "thinking") {
      return { available: false, reason: "too-late" };
    }
  }
  const reason = handler.unavailableReason?.() ?? null;
  return { available: reason === null, reason };
}

function entryControls(entry: InflightEntry): ApiProxyInflightControls {
  const controls = {} as ApiProxyInflightControls;
  for (const action of ["force-answer", "finish", "cancel"] as const) {
    controls[controlKey(action)] = controlAvailability(entry, action);
  }
  return controls;
}

type ApiProxyInflightRegistryOptions = {
  now?: () => number;
  staleAfterMs?: number;
  endedRetainMs?: number;
};

export type ApiProxyInflightHandle = {
  readonly id: string;
  setModel(modelId: string): void;
  setOrigin(originId: string): void;
  setSource(sourceId: string, sourceName: string): void;
  setTarget(targetId: string | null): void;
  setStream(stream: boolean): void;
  dispatched(): void;
  firstReasoning(): void;
  firstToken(promptTokens?: number | null): void;
  setPromptTokens(value: number | null): void;
  setCompletionTokens(value: number): void;
  setPrefillProgress(progress: {
    total: number;
    processed: number;
    cache: number;
  }): void;
  appendReasoning(text: string): void;
  appendAnswer(text: string): void;
  appendToolCall(delta: {
    index: number;
    id?: string | undefined;
    name?: string | undefined;
    arguments?: string | undefined;
  }): void;
  setControl(
    action: ApiProxyInflightControlAction,
    handler: ApiProxyInflightControlHandler | null,
  ): void;
  controlSignal(action: ApiProxyInflightControlAction): AbortSignal;
  end(ok?: boolean): void;
};

function toView(entry: InflightEntry, at: number): ApiProxyInflightRequest {
  const endAt = entry.endedAt ?? at;
  const waitingMs = Math.max(
    0,
    Math.round((entry.dispatchedAt ?? endAt) - entry.enqueuedAt),
  );
  const prefillEndAt = entry.reasoningStartedAt ?? entry.firstTokenAt ?? endAt;
  const prefillMs =
    entry.dispatchedAt === null
      ? null
      : Math.max(0, Math.round(prefillEndAt - entry.dispatchedAt));
  const thinkingMs =
    entry.reasoningStartedAt === null
      ? null
      : Math.max(
          0,
          Math.round((entry.firstTokenAt ?? endAt) - entry.reasoningStartedAt),
        );
  const generatingMs =
    entry.firstTokenAt === null
      ? null
      : Math.max(0, Math.round(endAt - entry.firstTokenAt));
  return {
    id: entry.id,
    originId: entry.originId,
    modelId: entry.modelId,
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    protocol: entry.protocol,
    stream: entry.stream,
    phase: entry.phase,
    waitingMs,
    prefillMs,
    thinkingMs,
    generatingMs,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    prefillTotalTokens: entry.prefillTotalTokens,
    prefillProcessedTokens: entry.prefillProcessedTokens,
    prefillCachedTokens: entry.prefillCachedTokens,
    reasoningChars: entry.reasoningCharsTotal,
    answerChars: entry.answerCharsTotal,
    toolCalls: entry.toolCalls.filter(Boolean).length,
    controls: entryControls(entry),
  };
}

export class ApiProxyInflightRegistry {
  private readonly entries = new Map<string, InflightEntry>();
  private readonly clock: () => number;
  private readonly staleAfterMs: number;
  private readonly endedRetainMs: number;

  constructor(options: ApiProxyInflightRegistryOptions = {}) {
    this.clock = options.now ?? (() => performance.now());
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_INFLIGHT_STALE_AFTER_MS;
    this.endedRetainMs =
      options.endedRetainMs ?? DEFAULT_INFLIGHT_ENDED_RETAIN_MS;
  }

  begin(input: {
    modelId: string;
    protocol: "openai" | "anthropic";
    targetId?: string | null;
    stream?: boolean;
  }): ApiProxyInflightHandle {
    const startedAt = this.clock();
    const entry: InflightEntry = {
      id: newId(),
      originId: null,
      targetId: input.targetId ?? null,
      modelId: input.modelId,
      sourceId: null,
      sourceName: null,
      protocol: input.protocol,
      stream: input.stream ?? false,
      phase: "queued",
      enqueuedAt: startedAt,
      dispatchedAt: null,
      reasoningStartedAt: null,
      firstTokenAt: null,
      lastProgressAt: startedAt,
      promptTokens: null,
      completionTokens: 0,
      prefillTotalTokens: null,
      prefillProcessedTokens: null,
      prefillCachedTokens: null,
      reasoningText: "",
      reasoningCharsTotal: 0,
      answerText: "",
      answerCharsTotal: 0,
      toolCalls: [],
      controlHandlers: {},
      controlControllers: {},
      endedAt: null,
    };
    this.entries.set(entry.id, entry);
    const touch = () => {
      entry.lastProgressAt = this.clock();
    };
    return {
      id: entry.id,
      setModel: (modelId) => {
        entry.modelId = modelId;
      },
      setOrigin: (originId) => {
        entry.originId = originId;
      },
      setSource: (sourceId, sourceName) => {
        entry.sourceId = sourceId;
        entry.sourceName = sourceName;
      },
      setTarget: (targetId) => {
        entry.targetId = targetId;
      },
      setStream: (stream) => {
        entry.stream = stream;
      },
      dispatched: () => {
        if (entry.dispatchedAt === null) {
          entry.dispatchedAt = this.clock();
        }
        if (entry.phase === "queued") {
          entry.phase = "prefilling";
        }
        touch();
      },
      firstReasoning: () => {
        if (entry.reasoningStartedAt === null) {
          entry.reasoningStartedAt = this.clock();
        }
        if (entry.phase === "queued" || entry.phase === "prefilling") {
          entry.phase = "thinking";
        }
        touch();
      },
      firstToken: (promptTokens) => {
        if (entry.firstTokenAt === null) {
          entry.firstTokenAt = this.clock();
        }
        entry.phase = "generating";
        if (
          promptTokens !== undefined &&
          promptTokens !== null &&
          entry.promptTokens === null
        ) {
          entry.promptTokens = promptTokens;
        }
        touch();
      },
      setPromptTokens: (value) => {
        if (value !== null && entry.promptTokens === null) {
          entry.promptTokens = value;
        }
      },
      setCompletionTokens: (value) => {
        if (value > entry.completionTokens) {
          entry.completionTokens = value;
          touch();
        }
      },
      setPrefillProgress: (progress) => {
        entry.prefillTotalTokens = progress.total;
        entry.prefillProcessedTokens = progress.processed;
        entry.prefillCachedTokens = progress.cache;
        if (entry.promptTokens === null && progress.total > 0) {
          entry.promptTokens = progress.total;
        }
        touch();
      },
      appendReasoning: (text) => {
        if (text.length === 0) {
          return;
        }
        entry.reasoningCharsTotal += text.length;
        entry.reasoningText = appendCapped(
          entry.reasoningText,
          text,
          REASONING_BUFFER_CAP,
        );
        touch();
      },
      appendAnswer: (text) => {
        if (text.length === 0) {
          return;
        }
        entry.answerCharsTotal += text.length;
        entry.answerText = appendCapped(
          entry.answerText,
          text,
          ANSWER_BUFFER_CAP,
        );
        touch();
      },
      appendToolCall: (delta) => {
        const existing = entry.toolCalls[delta.index] ?? {
          id: null,
          name: null,
          arguments: "",
        };
        entry.toolCalls[delta.index] = {
          id: delta.id ?? existing.id,
          name: delta.name ?? existing.name,
          arguments: appendCapped(
            existing.arguments,
            delta.arguments ?? "",
            TOOL_ARGS_BUFFER_CAP,
          ),
        };
        if (entry.phase !== "queued" && entry.phase !== "prefilling") {
          entry.phase = "tool";
        }
        touch();
      },
      setControl: (action, handler) => {
        if (handler) {
          entry.controlHandlers[action] = handler;
        } else {
          delete entry.controlHandlers[action];
        }
      },
      controlSignal: (action) => {
        let controller = entry.controlControllers[action];
        if (!controller || controller.signal.aborted) {
          controller = new AbortController();
          entry.controlControllers[action] = controller;
        }
        entry.controlHandlers[action] = {
          execute: () => {
            controller.abort();
          },
        };
        return controller.signal;
      },
      end: (ok = true) => {
        if (entry.endedAt !== null) {
          return;
        }
        entry.endedAt = this.clock();
        entry.phase = ok ? "done" : "failed";
      },
    };
  }

  private sweepStale(at: number): void {
    for (const [id, entry] of this.entries) {
      const expired =
        entry.endedAt !== null
          ? at - entry.endedAt > this.endedRetainMs
          : at - entry.lastProgressAt > this.staleAfterMs;
      if (expired) {
        this.entries.delete(id);
      }
    }
  }

  activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.endedAt === null) {
        count += 1;
      }
    }
    return count;
  }

  activeTargetIds(): Set<string> {
    const targetIds = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.endedAt === null && entry.targetId !== null) {
        targetIds.add(entry.targetId);
      }
    }
    return targetIds;
  }

  snapshotByTarget(): Map<string, ApiProxyInflightRequest[]> {
    const at = this.clock();
    this.sweepStale(at);
    const byTarget = new Map<string, ApiProxyInflightRequest[]>();
    for (const entry of this.entries.values()) {
      if (entry.targetId === null) {
        continue;
      }
      const view = toView(entry, at);
      const list = byTarget.get(entry.targetId);
      if (list) {
        list.push(view);
      } else {
        byTarget.set(entry.targetId, [view]);
      }
    }
    return byTarget;
  }

  snapshotList(): ApiProxyInflightRequest[] {
    const at = this.clock();
    this.sweepStale(at);
    return [...this.entries.values()].map((entry) => toView(entry, at));
  }

  snapshotByModel(): Map<string, ApiProxyInflightRequest[]> {
    const at = this.clock();
    this.sweepStale(at);
    const byModel = new Map<string, ApiProxyInflightRequest[]>();
    for (const entry of this.entries.values()) {
      if (entry.modelId === "") {
        continue;
      }
      const view = toView(entry, at);
      const list = byModel.get(entry.modelId);
      if (list) {
        list.push(view);
      } else {
        byModel.set(entry.modelId, [view]);
      }
    }
    return byModel;
  }

  getDetail(id: string): ApiProxyInflightDetail | null {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    return {
      id: entry.id,
      modelId: entry.modelId,
      protocol: entry.protocol,
      phase: entry.phase,
      reasoningText: entry.reasoningText,
      reasoningChars: entry.reasoningCharsTotal,
      reasoningTruncated:
        entry.reasoningCharsTotal > entry.reasoningText.length,
      answerText: entry.answerText,
      answerChars: entry.answerCharsTotal,
      answerTruncated: entry.answerCharsTotal > entry.answerText.length,
      toolCalls: entry.toolCalls
        .filter(Boolean)
        .map((call) => ({ name: call.name, arguments: call.arguments })),
      completionTokens: entry.completionTokens,
      controls: entryControls(entry),
    };
  }

  async requestControl(
    id: string,
    action: ApiProxyInflightControlAction,
  ): Promise<ApiProxyInflightControlResult> {
    const entry = this.entries.get(id);
    if (!entry || entry.endedAt !== null) {
      return { status: "not-found", message: null };
    }
    const availability = controlAvailability(entry, action);
    if (!availability.available) {
      return {
        status:
          availability.reason === "request-finished"
            ? "not-found"
            : (availability.reason ?? "not-supported"),
        message: null,
      };
    }
    const handler = entry.controlHandlers[action];
    if (!handler) {
      return { status: "not-supported", message: null };
    }
    try {
      const result = await handler.execute();
      return result ?? { status: "ok", message: null };
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  reset(): void {
    this.entries.clear();
  }
}

export const apiProxyInflight = new ApiProxyInflightRegistry();
