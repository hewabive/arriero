import type { BenchmarkServerTimings } from "@arriero/core";

import {
  streamDeltaText,
  streamErrorMessage,
  streamFinishReason,
} from "../api-lab/sse-parse.js";
import { asObject, numberOrNull } from "../proxy/json.js";
import { upstreamErrorText } from "../proxy/protocol-trace.js";
import { consumeSseEvents } from "../proxy/sse.js";

export type MeasuredStreamOutcome = {
  submitMs: number;
  firstTokenMs: number | null;
  doneMs: number | null;
  endedMs: number;
  timedOut: boolean;
  chunkTimesMs: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  serverTimings: BenchmarkServerTimings | null;
  finishReason: string | null;
  error: string | null;
};

export type MeasuredRequestInput = {
  url: string;
  body: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
};

const ERROR_BODY_LIMIT = 300;

export const CANCELED_REQUEST_ERROR = "canceled";

function serverTimingsFrom(value: unknown): BenchmarkServerTimings | null {
  const record = asObject(value);
  if (!record) return null;
  return {
    promptN: numberOrNull(record.prompt_n),
    promptMs: numberOrNull(record.prompt_ms),
    predictedN: numberOrNull(record.predicted_n),
    predictedMs: numberOrNull(record.predicted_ms),
    draftN: numberOrNull(record.draft_n),
    draftNAccepted: numberOrNull(record.draft_n_accepted),
  };
}

export async function runMeasuredRequest(
  input: MeasuredRequestInput,
): Promise<MeasuredStreamOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => performance.now());
  const chunkTimesMs: number[] = [];
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let serverTimings: BenchmarkServerTimings | null = null;
  let finishReason: string | null = null;
  let error: string | null = null;
  let malformedFrames = 0;
  let streamCompleted = false;

  const submitMs = now();
  const timeout = new AbortController();
  const timer =
    input.timeoutMs === undefined
      ? null
      : setTimeout(() => timeout.abort(), input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout.signal])
    : timeout.signal;
  let timedOut = false;
  try {
    const response = await fetchImpl(input.url, {
      method: "POST",
      body: JSON.stringify(input.body),
      headers: { "content-type": "application/json", ...input.headers },
      signal,
    });

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const suffix = rawBody
        ? `: ${upstreamErrorText(rawBody).slice(0, ERROR_BODY_LIMIT)}`
        : "";
      error = `upstream ${response.status}${suffix}`;
    } else if (!response.body) {
      error = "upstream returned no stream body";
    } else {
      await consumeSseEvents(response.body, (data) => {
        if (data === "[DONE]") {
          streamCompleted = true;
          return true;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          malformedFrames += 1;
          return false;
        }
        const streamError = streamErrorMessage(parsed);
        if (streamError !== null) {
          error = `upstream stream error: ${streamError.slice(0, ERROR_BODY_LIMIT)}`;
          return true;
        }
        if (streamDeltaText(parsed)) {
          chunkTimesMs.push(now());
        }
        finishReason = streamFinishReason(parsed) ?? finishReason;
        const record = asObject(parsed);
        const usage = asObject(record?.usage);
        if (usage) {
          promptTokens = numberOrNull(usage.prompt_tokens) ?? promptTokens;
          completionTokens =
            numberOrNull(usage.completion_tokens) ?? completionTokens;
        }
        const timings = serverTimingsFrom(record?.timings);
        if (timings) {
          serverTimings = timings;
        }
        return false;
      });
    }
  } catch (cause) {
    timedOut = timeout.signal.aborted && !input.signal?.aborted;
    error = input.signal?.aborted
      ? CANCELED_REQUEST_ERROR
      : timedOut
        ? `request timed out after ${input.timeoutMs} ms`
        : (cause as Error).message;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (error === null && malformedFrames > 0) {
    error = `${malformedFrames} malformed stream frames`;
  }
  if (error === null && !streamCompleted && finishReason === null) {
    error = "upstream stream ended before completion";
  }
  if (error === null && chunkTimesMs.length === 0) {
    error = "upstream returned no generated content";
  }

  const outcome: MeasuredStreamOutcome = {
    submitMs,
    firstTokenMs: chunkTimesMs[0] ?? null,
    doneMs: chunkTimesMs.at(-1) ?? null,
    endedMs: now(),
    timedOut,
    chunkTimesMs,
    promptTokens,
    completionTokens,
    serverTimings,
    finishReason,
    error,
  };
  if (outcome.promptTokens === null && outcome.serverTimings) {
    outcome.promptTokens = outcome.serverTimings.promptN;
  }
  if (outcome.completionTokens === null && outcome.serverTimings) {
    outcome.completionTokens = outcome.serverTimings.predictedN;
  }
  return outcome;
}
