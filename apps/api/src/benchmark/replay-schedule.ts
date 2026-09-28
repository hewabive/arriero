import type {
  BenchmarkReplayArrival,
  BenchmarkReplayThinkTime,
} from "@arriero/core";

export type ReplayClock = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type ReplaySegmentPlan = {
  startOffsetMs: number;
  thinkTimesMs: Array<number | null>;
};

export type ReplaySend = (
  request: { segmentIndex: number; recordIndex: number },
  signal: AbortSignal,
) => Promise<void>;

export const realReplayClock: ReplayClock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted || ms <= 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", stop, { once: true });
    }),
};

export function replayThinkTimeMs(
  recordedMs: number | null,
  policy: BenchmarkReplayThinkTime,
): number {
  const recorded = Math.max(0, recordedMs ?? 0);
  switch (policy.kind) {
    case "recorded":
      return recorded;
    case "scaled":
      return recorded * policy.factor;
    case "capped":
      return Math.min(recorded, policy.maxMs);
    case "none":
      return 0;
  }
}

export function replayStartOffsets(
  segments: readonly ReplaySegmentPlan[],
  arrival: BenchmarkReplayArrival,
): number[] {
  switch (arrival.kind) {
    case "recorded":
      return segments.map((segment) => Math.max(0, segment.startOffsetMs));
    case "together":
      return segments.map(() => 0);
    case "interval":
      return segments.map((_, index) => index * arrival.intervalMs);
  }
}

type SegmentState = {
  next: number;
  dueAt: number;
  running: boolean;
};

export async function runReplaySchedule(input: {
  segments: ReplaySegmentPlan[];
  arrival: BenchmarkReplayArrival;
  thinkTime: BenchmarkReplayThinkTime;
  idleSkipping: boolean;
  clock: ReplayClock;
  signal: AbortSignal;
  send: ReplaySend;
}): Promise<void> {
  const concurrencyCap =
    input.arrival.kind === "recorded" ? null : input.arrival.concurrencyCap;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const origin = input.clock.now();
  let skippedMs = 0;
  const virtualNow = () => input.clock.now() - origin + skippedMs;
  const offsets = replayStartOffsets(input.segments, input.arrival);
  const states: SegmentState[] = input.segments.map((_, index) => ({
    next: 0,
    dueAt: offsets[index] ?? 0,
    running: false,
  }));
  const remaining = () =>
    states.filter(
      (state, index) =>
        state.next < (input.segments[index]?.thinkTimesMs.length ?? 0),
    );
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;

  const start = (segmentIndex: number) => {
    const state = states[segmentIndex];
    const segment = input.segments[segmentIndex];
    if (!state || !segment) {
      return;
    }
    const recordIndex = state.next;
    state.running = true;
    const task = input
      .send({ segmentIndex, recordIndex }, signal)
      .then(() => {
        state.next = recordIndex + 1;
        state.running = false;
        state.dueAt =
          virtualNow() +
          replayThinkTimeMs(
            segment.thinkTimesMs[state.next] ?? null,
            input.thinkTime,
          );
      })
      .catch((error: unknown) => {
        failure ??= error;
        controller.abort();
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  while (remaining().length > 0 && failure === null) {
    if (input.signal.aborted) {
      break;
    }
    const now = virtualNow();
    const running = states.filter((state) => state.running).length;
    const capacity =
      concurrencyCap === null
        ? Number.POSITIVE_INFINITY
        : concurrencyCap - running;
    const due = states
      .map((state, index) => ({ state, index }))
      .filter(
        ({ state, index }) =>
          !state.running &&
          state.next < (input.segments[index]?.thinkTimesMs.length ?? 0) &&
          state.dueAt <= now,
      )
      .sort((left, right) => left.state.dueAt - right.state.dueAt)
      .slice(0, Math.max(0, capacity));
    for (const { index } of due) {
      start(index);
    }
    const waiting = states.filter(
      (state, index) =>
        !state.running &&
        state.next < (input.segments[index]?.thinkTimesMs.length ?? 0),
    );
    const nextDue = waiting.reduce(
      (earliest, state) => Math.min(earliest, state.dueAt),
      Number.POSITIVE_INFINITY,
    );
    if (inFlight.size === 0) {
      if (!Number.isFinite(nextDue)) {
        break;
      }
      const gap = nextDue - virtualNow();
      if (gap > 0) {
        if (input.idleSkipping) {
          skippedMs += gap;
        } else {
          await input.clock.sleep(gap, signal);
        }
      }
      continue;
    }
    const capped =
      concurrencyCap !== null &&
      states.filter((state) => state.running).length >= concurrencyCap;
    const sleepMs =
      capped || !Number.isFinite(nextDue)
        ? null
        : Math.max(0, nextDue - virtualNow());
    const wake = new AbortController();
    const sleeping =
      sleepMs === null
        ? null
        : input.clock.sleep(sleepMs, AbortSignal.any([signal, wake.signal]));
    await Promise.race([...inFlight, ...(sleeping ? [sleeping] : [])]);
    wake.abort();
  }

  await Promise.allSettled([...inFlight]);
  if (failure !== null) {
    throw failure;
  }
  if (input.signal.aborted) {
    throw new Error("canceled");
  }
}
