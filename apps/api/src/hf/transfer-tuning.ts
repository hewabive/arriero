const MIB = 1024 * 1024;
const MIN_CHUNK_BYTES = 16 * MIB;
const MAX_CHUNK_BYTES = 128 * MIB;
const CHUNK_QUANTUM_BYTES = 4 * MIB;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_INITIAL_CONNECTIONS = 4;
const TUNING_WINDOW_MS = 1_500;
const PROBE_KEEP_RATIO = 1.05;
const PLATEAU_RETRY_MS = 10_000;
const ERROR_RETRY_MS = 15_000;
const RATE_LIMIT_RETRY_MS = 30_000;

export type HfTransferTuningOverrides = {
  chunkBytes?: number | undefined;
  initialConnections?: number | undefined;
  maxConnections?: number | undefined;
  now?: (() => number) | undefined;
};

export function hfMaxConnections(
  overrides?: HfTransferTuningOverrides,
): number {
  return Math.max(
    1,
    Math.min(16, overrides?.maxConnections ?? DEFAULT_MAX_CONNECTIONS),
  );
}

export function hfInitialConnections(
  overrides?: HfTransferTuningOverrides,
): number {
  return Math.min(
    hfMaxConnections(overrides),
    Math.max(1, overrides?.initialConnections ?? DEFAULT_INITIAL_CONNECTIONS),
  );
}

export function hfChunkBytes(
  fileSize: number,
  overrides?: HfTransferTuningOverrides,
): number {
  if (overrides?.chunkBytes !== undefined) {
    return Math.max(1, overrides.chunkBytes);
  }
  const targetChunks = Math.max(8, hfMaxConnections(overrides) * 4);
  const ideal = Math.ceil(fileSize / targetChunks);
  const rounded = Math.ceil(ideal / CHUNK_QUANTUM_BYTES) * CHUNK_QUANTUM_BYTES;
  return Math.max(MIN_CHUNK_BYTES, Math.min(MAX_CHUNK_BYTES, rounded));
}

type HfConnectionTunerOptions = {
  initialConnections: number;
  maxConnections: number;
  now: () => number;
  onChange: (connections: number) => void;
};

export class HfConnectionTuner {
  readonly #maxConnections: number;
  readonly #now: () => number;
  readonly #onChange: (connections: number) => void;
  #baselineBps: number | null = null;
  #bytes = 0;
  #lastBackoffAt = Number.NEGATIVE_INFINITY;
  #nextProbeAt = 0;
  #probeFrom: number | null = null;
  #target: number;
  #windowStartedAt: number;

  constructor(options: HfConnectionTunerOptions) {
    this.#maxConnections = options.maxConnections;
    this.#now = options.now;
    this.#onChange = options.onChange;
    this.#target = options.initialConnections;
    this.#windowStartedAt = options.now();
  }

  get connections(): number {
    return this.#target;
  }

  recordBytes(bytes: number): void {
    if (bytes <= 0) {
      return;
    }
    this.#bytes += bytes;
    this.#evaluate(this.#now());
  }

  recordRateLimit(): void {
    const now = this.#now();
    if (now - this.#lastBackoffAt < 1_000) {
      return;
    }
    this.#lastBackoffAt = now;
    this.#baselineBps = null;
    this.#probeFrom = null;
    this.#nextProbeAt = now + RATE_LIMIT_RETRY_MS;
    this.#setTarget(Math.max(1, Math.floor(this.#target / 2)));
    this.#resetWindow(now);
  }

  recordTransportError(): void {
    const now = this.#now();
    if (now - this.#lastBackoffAt < 1_000) {
      return;
    }
    this.#lastBackoffAt = now;
    this.#baselineBps = null;
    this.#probeFrom = null;
    this.#nextProbeAt = now + ERROR_RETRY_MS;
    this.#setTarget(Math.max(1, this.#target - 1));
    this.#resetWindow(now);
  }

  #evaluate(now: number): void {
    const elapsed = now - this.#windowStartedAt;
    if (elapsed < TUNING_WINDOW_MS) {
      return;
    }
    const rate = (this.#bytes * 1_000) / elapsed;
    if (this.#probeFrom !== null) {
      if (
        this.#baselineBps !== null &&
        rate >= this.#baselineBps * PROBE_KEEP_RATIO
      ) {
        this.#baselineBps = rate;
        this.#probeFrom = null;
        this.#startProbe(now);
      } else {
        this.#setTarget(this.#probeFrom);
        this.#probeFrom = null;
        this.#nextProbeAt = now + PLATEAU_RETRY_MS;
      }
      this.#resetWindow(now);
      return;
    }
    this.#baselineBps = rate;
    if (now >= this.#nextProbeAt) {
      this.#startProbe(now);
    }
    this.#resetWindow(now);
  }

  #startProbe(now: number): void {
    if (this.#target >= this.#maxConnections) {
      this.#nextProbeAt = now + PLATEAU_RETRY_MS;
      return;
    }
    this.#probeFrom = this.#target;
    this.#setTarget(this.#target + 1);
  }

  #resetWindow(now: number): void {
    this.#bytes = 0;
    this.#windowStartedAt = now;
  }

  #setTarget(value: number): void {
    const next = Math.max(1, Math.min(this.#maxConnections, value));
    if (next === this.#target) {
      return;
    }
    this.#target = next;
    this.#onChange(next);
  }
}
