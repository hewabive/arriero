import assert from "node:assert/strict";
import { test } from "node:test";

import {
  replayThinkTimeMs,
  runReplaySchedule,
  type ReplayClock,
  type ReplaySegmentPlan,
} from "./replay-schedule.js";

class VirtualClock implements ReplayClock {
  time = 0;
  private timers: Array<{ at: number; resolve: () => void }> = [];

  now = () => this.time;

  sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = { at: this.time + Math.max(0, ms), resolve };
      this.timers.push(timer);
      signal.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((entry) => entry !== timer);
          resolve();
        },
        { once: true },
      );
    });

  async drive(until: Promise<unknown>): Promise<void> {
    let settled = false;
    void until.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let step = 0; step < 10_000; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled) {
        return;
      }
      this.timers.sort((left, right) => left.at - right.at);
      const next = this.timers.shift();
      if (!next) {
        throw new Error("the schedule is waiting on nothing");
      }
      this.time = Math.max(this.time, next.at);
      next.resolve();
    }
    throw new Error("the schedule did not finish");
  }
}

function replay(input: {
  clock: VirtualClock;
  segments: ReplaySegmentPlan[];
  durationMs: (segment: number, record: number) => number;
  idleSkipping?: boolean;
  arrival?: Parameters<typeof runReplaySchedule>[0]["arrival"];
  thinkTime?: Parameters<typeof runReplaySchedule>[0]["thinkTime"];
  failAt?: { segment: number; record: number };
}) {
  const sends: Array<{ segment: number; record: number; at: number }> = [];
  const run = runReplaySchedule({
    segments: input.segments,
    arrival: input.arrival ?? { kind: "recorded" },
    thinkTime: input.thinkTime ?? { kind: "recorded" },
    idleSkipping: input.idleSkipping ?? false,
    clock: input.clock,
    signal: new AbortController().signal,
    send: async ({ segmentIndex, recordIndex }, signal) => {
      sends.push({
        segment: segmentIndex,
        record: recordIndex,
        at: input.clock.now(),
      });
      await input.clock.sleep(
        input.durationMs(segmentIndex, recordIndex),
        signal,
      );
      if (
        input.failAt?.segment === segmentIndex &&
        input.failAt.record === recordIndex
      ) {
        throw new Error("engine failed");
      }
    },
  });
  return { run, sends };
}

test("think time runs from the end of the replayed answer", async () => {
  const segments = [{ startOffsetMs: 0, thinkTimesMs: [null, 500, 500] }];
  const slow = new VirtualClock();
  const slowRun = replay({ clock: slow, segments, durationMs: () => 2000 });
  await slow.drive(slowRun.run);
  assert.deepEqual(
    slowRun.sends.map((send) => send.at),
    [0, 2500, 5000],
  );
  const fast = new VirtualClock();
  const fastRun = replay({ clock: fast, segments, durationMs: () => 500 });
  await fast.drive(fastRun.run);
  assert.deepEqual(
    fastRun.sends.map((send) => send.at),
    [0, 1000, 2000],
  );
});

test("segments start at their recorded offsets and overlap", async () => {
  const clock = new VirtualClock();
  const { run, sends } = replay({
    clock,
    segments: [
      { startOffsetMs: 0, thinkTimesMs: [null, 0] },
      { startOffsetMs: 1000, thinkTimesMs: [null] },
    ],
    durationMs: () => 3000,
  });
  await clock.drive(run);
  assert.deepEqual(
    sends.map((send) => [send.segment, send.record, send.at]),
    [
      [0, 0, 0],
      [1, 0, 1000],
      [0, 1, 3000],
    ],
  );
});

test("idle time is skipped only while nothing is in flight", async () => {
  const clock = new VirtualClock();
  const { run, sends } = replay({
    clock,
    idleSkipping: true,
    segments: [
      { startOffsetMs: 5000, thinkTimesMs: [null, 60_000] },
      { startOffsetMs: 6000, thinkTimesMs: [null] },
    ],
    durationMs: (segment) => (segment === 1 ? 10_000 : 2000),
  });
  await clock.drive(run);
  assert.deepEqual(
    sends.map((send) => [send.segment, send.record, send.at]),
    [
      [0, 0, 0],
      [1, 0, 1000],
      [0, 1, 11000],
    ],
  );
});

test("composed arrivals and the concurrency cap", async () => {
  const together = new VirtualClock();
  const capped = replay({
    clock: together,
    arrival: { kind: "together", concurrencyCap: 2 },
    segments: [
      { startOffsetMs: 900, thinkTimesMs: [null] },
      { startOffsetMs: 50, thinkTimesMs: [null] },
      { startOffsetMs: 10, thinkTimesMs: [null] },
    ],
    durationMs: () => 1000,
  });
  await together.drive(capped.run);
  assert.deepEqual(
    capped.sends.map((send) => send.at),
    [0, 0, 1000],
  );
  const staggered = new VirtualClock();
  const interval = replay({
    clock: staggered,
    arrival: { kind: "interval", intervalMs: 250, concurrencyCap: null },
    segments: [
      { startOffsetMs: 0, thinkTimesMs: [null] },
      { startOffsetMs: 0, thinkTimesMs: [null] },
      { startOffsetMs: 0, thinkTimesMs: [null] },
    ],
    durationMs: () => 1000,
  });
  await staggered.drive(interval.run);
  assert.deepEqual(
    interval.sends.map((send) => send.at),
    [0, 250, 500],
  );
});

test("the first failure stops every segment", async () => {
  const clock = new VirtualClock();
  const { run, sends } = replay({
    clock,
    segments: [
      { startOffsetMs: 0, thinkTimesMs: [null, 0, 0] },
      { startOffsetMs: 0, thinkTimesMs: [null, 0, 0] },
    ],
    durationMs: (segment) => (segment === 0 ? 100 : 1000),
    failAt: { segment: 0, record: 1 },
  });
  const outcome = run.then(
    () => null,
    (error: unknown) => error,
  );
  await clock.drive(outcome);
  assert.match(String(await outcome), /engine failed/);
  assert.equal(
    sends.some((send) => send.segment === 0 && send.record === 2),
    false,
  );
  assert.equal(
    sends.some((send) => send.segment === 1 && send.record === 1),
    false,
  );
});

test("think time policies", () => {
  assert.equal(replayThinkTimeMs(4000, { kind: "recorded" }), 4000);
  assert.equal(replayThinkTimeMs(4000, { kind: "scaled", factor: 0.5 }), 2000);
  assert.equal(replayThinkTimeMs(4000, { kind: "capped", maxMs: 1000 }), 1000);
  assert.equal(replayThinkTimeMs(4000, { kind: "none" }), 0);
  assert.equal(replayThinkTimeMs(null, { kind: "recorded" }), 0);
});
