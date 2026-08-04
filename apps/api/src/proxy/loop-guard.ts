import { deflateRawSync } from "node:zlib";
import type { ApiProxyLoopGuardConfig } from "@arriero/core";

export type ApiProxyLoopGuardLane = "answer" | "reasoning" | "tool";

export type ApiProxyLoopGuardSignal =
  | "period"
  | "novelty"
  | "compression"
  | "entropy";

export type ApiProxyLoopGuardStatus = "clean" | "near-miss" | "triggered";

export type ApiProxyLoopGuardHit = {
  lane: ApiProxyLoopGuardLane;
  signal: ApiProxyLoopGuardSignal;
  score: number;
  value: number;
  atChars: number;
  tail: string;
};

export type ApiProxyLoopGuardTimelineEntry = {
  atChars: number;
  lane: ApiProxyLoopGuardLane;
  signal: ApiProxyLoopGuardSignal;
  score: number;
  value: number;
};

export type ApiProxyLoopGuardSnapshot = {
  status: ApiProxyLoopGuardStatus;
  trigger: ApiProxyLoopGuardHit | null;
  peak: ApiProxyLoopGuardHit | null;
  scannedChars: number;
  timeline: ApiProxyLoopGuardTimelineEntry[];
};

export type ApiProxyLoopGuardDetector = {
  append: (
    lane: ApiProxyLoopGuardLane,
    text: string,
  ) => ApiProxyLoopGuardHit | null;
  finalize: () => ApiProxyLoopGuardHit | null;
  snapshot: () => ApiProxyLoopGuardSnapshot;
};

const EVAL_STEP_CHARS = 512;
const TAIL_CAP_CHARS = 16_384;
const TAIL_SAMPLE_CHARS = 2048;
const NGRAM_CHARS = 16;
const SEEN_HASH_GENERATION_CAP = 16_384;
const COMPRESSION_SAMPLE_CHARS = 4096;
const COMPRESSION_MIN_TAIL_CHARS = 2048;
const COMPRESSION_CADENCE_CHARS = 2048;
const COMPRESSION_REFERENCE_RATIO = 0.3;
const ENTROPY_SAMPLE_CHARS = 2048;
const ENTROPY_MIN_TAIL_CHARS = 1024;
const ENTROPY_REFERENCE_BITS = 4;
const PERIOD_WINDOW_CHARS = [512, 1024, 2048, 4096];
const SHORT_PERIOD_CHARS = 4;
const SHORT_PERIOD_MIN_WINDOW_CHARS = 2048;
const SCORE_CAP = 2;
const TRIGGER_CONSECUTIVE_EVALS = 2;
const FINALIZE_MIN_CHARS = 64;
const TIMELINE_CAP = 200;
const TIMELINE_MIN_SCORE = 0.25;

class SeenHashes {
  private current = new Set<number>();
  private previous = new Set<number>();

  has(hash: number): boolean {
    return this.current.has(hash) || this.previous.has(hash);
  }

  add(hash: number): void {
    this.current.add(hash);
    if (this.current.size >= SEEN_HASH_GENERATION_CAP) {
      this.previous = this.current;
      this.current = new Set();
    }
  }
}

function ngramHashes(text: string): number[] {
  const hashes: number[] = [];
  if (text.length < NGRAM_CHARS) {
    return hashes;
  }
  let hash = 0;
  for (let index = 0; index < NGRAM_CHARS; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  }
  hashes.push(hash);
  let power = 1;
  for (let index = 1; index < NGRAM_CHARS; index += 1) {
    power = Math.imul(power, 31) >>> 0;
  }
  for (let start = 1; start + NGRAM_CHARS <= text.length; start += 1) {
    const outgoing = Math.imul(text.charCodeAt(start - 1), power);
    hash = (hash - outgoing) >>> 0;
    hash =
      (Math.imul(hash, 31) + text.charCodeAt(start + NGRAM_CHARS - 1)) >>> 0;
    hashes.push(hash);
  }
  return hashes;
}

function smallestPeriod(text: string): number {
  const length = text.length;
  const prefix = new Int32Array(length);
  for (let index = 1; index < length; index += 1) {
    let candidate = prefix[index - 1] ?? 0;
    while (
      candidate > 0 &&
      text.charCodeAt(index) !== text.charCodeAt(candidate)
    ) {
      candidate = prefix[candidate - 1] ?? 0;
    }
    if (text.charCodeAt(index) === text.charCodeAt(candidate)) {
      candidate += 1;
    }
    prefix[index] = candidate;
  }
  return length - (prefix[length - 1] ?? 0);
}

function clampScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  return Math.min(score, SCORE_CAP);
}

type SignalReading = {
  signal: ApiProxyLoopGuardSignal;
  score: number;
  value: number;
};

class LaneState {
  totalChars = 0;
  private pending = "";
  private carry = "";
  private tail = "";
  private lastCompressionAt = 0;
  private readonly seen = new SeenHashes();
  private readonly consecutive: Record<ApiProxyLoopGuardSignal, number> = {
    period: 0,
    novelty: 0,
    compression: 0,
    entropy: 0,
  };

  constructor(
    private readonly lane: ApiProxyLoopGuardLane,
    private readonly config: ApiProxyLoopGuardConfig,
  ) {}

  push(text: string): void {
    this.pending += text;
  }

  hasEvalReady(): boolean {
    return this.pending.length >= EVAL_STEP_CHARS;
  }

  hasFinalizeReady(): boolean {
    return this.pending.length >= FINALIZE_MIN_CHARS;
  }

  evaluate(): SignalReading[] {
    const step = Math.min(this.pending.length, EVAL_STEP_CHARS * 4);
    const slice = this.pending.slice(0, step);
    this.pending = this.pending.slice(step);
    const readings: SignalReading[] = [];
    const novelty = this.evaluateNovelty(slice);
    this.tail = (this.tail + slice).slice(-TAIL_CAP_CHARS);
    this.totalChars += slice.length;
    const armed = this.totalChars >= this.config.minSpanChars;
    if (armed && novelty !== null) {
      readings.push({
        signal: "novelty",
        value: novelty,
        score: clampScore((1 - novelty) / (1 - this.config.noveltyThreshold)),
      });
    }
    if (armed) {
      const period = this.evaluatePeriod();
      if (period !== null) {
        readings.push(period);
      }
      const compression = this.evaluateCompression();
      if (compression !== null) {
        readings.push(compression);
      }
      const entropy = this.evaluateEntropy();
      if (entropy !== null) {
        readings.push(entropy);
      }
    }
    for (const reading of readings) {
      if (reading.score >= 1) {
        this.consecutive[reading.signal] += 1;
      } else {
        this.consecutive[reading.signal] = 0;
      }
    }
    return readings;
  }

  triggeredSignal(): ApiProxyLoopGuardSignal | null {
    for (const signal of Object.keys(this.consecutive) as Array<
      keyof typeof this.consecutive
    >) {
      if (this.consecutive[signal] >= TRIGGER_CONSECUTIVE_EVALS) {
        return signal;
      }
    }
    return null;
  }

  tailSample(): string {
    return this.tail.slice(-TAIL_SAMPLE_CHARS);
  }

  private evaluateNovelty(slice: string): number | null {
    const text = this.carry + slice;
    this.carry = text.slice(-(NGRAM_CHARS - 1));
    const hashes = ngramHashes(text);
    if (hashes.length === 0) {
      return null;
    }
    let novel = 0;
    for (const hash of hashes) {
      if (!this.seen.has(hash)) {
        novel += 1;
      }
    }
    for (const hash of hashes) {
      this.seen.add(hash);
    }
    return novel / hashes.length;
  }

  private evaluatePeriod(): SignalReading | null {
    let best: SignalReading | null = null;
    for (const window of PERIOD_WINDOW_CHARS) {
      if (this.tail.length < window) {
        continue;
      }
      const sample = this.tail.slice(-window);
      const period = smallestPeriod(sample);
      if (period > window / 2) {
        continue;
      }
      if (
        period <= SHORT_PERIOD_CHARS &&
        window < SHORT_PERIOD_MIN_WINDOW_CHARS
      ) {
        continue;
      }
      const repeats = window / period;
      const score = clampScore(repeats / this.config.periodMinRepeats);
      if (!best || score > best.score) {
        best = { signal: "period", value: repeats, score };
      }
    }
    return best;
  }

  private evaluateCompression(): SignalReading | null {
    if (this.tail.length < COMPRESSION_MIN_TAIL_CHARS) {
      return null;
    }
    if (this.totalChars - this.lastCompressionAt < COMPRESSION_CADENCE_CHARS) {
      return null;
    }
    this.lastCompressionAt = this.totalChars;
    const sample = this.tail.slice(-COMPRESSION_SAMPLE_CHARS);
    const raw = Buffer.from(sample, "utf8");
    const ratio = deflateRawSync(raw, { level: 6 }).length / raw.length;
    const score = clampScore(
      (COMPRESSION_REFERENCE_RATIO - ratio) /
        (COMPRESSION_REFERENCE_RATIO - this.config.compressionThreshold),
    );
    return { signal: "compression", value: ratio, score };
  }

  private evaluateEntropy(): SignalReading | null {
    if (this.tail.length < ENTROPY_MIN_TAIL_CHARS) {
      return null;
    }
    const sample = this.tail.slice(-ENTROPY_SAMPLE_CHARS);
    const counts = new Map<number, number>();
    for (let index = 0; index < sample.length; index += 1) {
      const code = sample.charCodeAt(index);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    let bits = 0;
    for (const count of counts.values()) {
      const probability = count / sample.length;
      bits -= probability * Math.log2(probability);
    }
    const score = clampScore(
      (ENTROPY_REFERENCE_BITS - bits) /
        (ENTROPY_REFERENCE_BITS - this.config.entropyThreshold),
    );
    return { signal: "entropy", value: bits, score };
  }
}

export function createApiProxyLoopGuardDetector(
  config: ApiProxyLoopGuardConfig,
): ApiProxyLoopGuardDetector {
  const lanes = new Map<ApiProxyLoopGuardLane, LaneState>();
  const timeline: ApiProxyLoopGuardTimelineEntry[] = [];
  let trigger: ApiProxyLoopGuardHit | null = null;
  let peak: ApiProxyLoopGuardHit | null = null;

  const laneState = (lane: ApiProxyLoopGuardLane): LaneState => {
    const existing = lanes.get(lane);
    if (existing) {
      return existing;
    }
    const created = new LaneState(lane, config);
    lanes.set(lane, created);
    return created;
  };

  const record = (
    lane: ApiProxyLoopGuardLane,
    state: LaneState,
    readings: SignalReading[],
  ): ApiProxyLoopGuardHit | null => {
    let top: SignalReading | null = null;
    for (const reading of readings) {
      if (!top || reading.score > top.score) {
        top = reading;
      }
    }
    if (
      top &&
      top.score >= TIMELINE_MIN_SCORE &&
      timeline.length < TIMELINE_CAP
    ) {
      timeline.push({
        atChars: state.totalChars,
        lane,
        signal: top.signal,
        score: top.score,
        value: top.value,
      });
    }
    if (top && (!peak || top.score > peak.score)) {
      peak = {
        lane,
        signal: top.signal,
        score: top.score,
        value: top.value,
        atChars: state.totalChars,
        tail: state.tailSample(),
      };
    }
    const firedSignal = state.triggeredSignal();
    if (firedSignal && !trigger) {
      const fired = readings.find((reading) => reading.signal === firedSignal);
      trigger = {
        lane,
        signal: firedSignal,
        score: fired?.score ?? 1,
        value: fired?.value ?? 0,
        atChars: state.totalChars,
        tail: state.tailSample(),
      };
      return trigger;
    }
    return null;
  };

  const drain = (
    lane: ApiProxyLoopGuardLane,
    state: LaneState,
    ready: (state: LaneState) => boolean,
  ): ApiProxyLoopGuardHit | null => {
    while (ready(state)) {
      const hit = record(lane, state, state.evaluate());
      if (hit) {
        return hit;
      }
    }
    return null;
  };

  return {
    append(lane, text) {
      if (trigger || text.length === 0) {
        return null;
      }
      const state = laneState(lane);
      state.push(text);
      return drain(lane, state, (item) => item.hasEvalReady());
    },
    finalize() {
      if (trigger) {
        return null;
      }
      for (const [lane, state] of lanes) {
        const hit = drain(lane, state, (item) => item.hasFinalizeReady());
        if (hit) {
          return hit;
        }
      }
      return null;
    },
    snapshot() {
      let scannedChars = 0;
      for (const state of lanes.values()) {
        scannedChars += state.totalChars;
      }
      const status: ApiProxyLoopGuardStatus = trigger
        ? "triggered"
        : peak && peak.score >= config.nearMissRatio
          ? "near-miss"
          : "clean";
      return {
        status,
        trigger,
        peak,
        scannedChars,
        timeline: [...timeline],
      };
    },
  };
}
