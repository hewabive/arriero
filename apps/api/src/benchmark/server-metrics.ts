import type {
  BenchmarkServerTimings,
  EngineBenchmarkServerMetricsId,
} from "@arriero/core";

import { logger } from "../logger.js";
import { sleep } from "../utils/sleep.js";

export type PrometheusHistogramTotals = {
  sumSeconds: number;
  count: number;
};

export type BenchmarkServerMetricsSource = {
  captureBefore(): Promise<PrometheusHistogramTotals | null>;
  requestTimings(
    before: PrometheusHistogramTotals | null,
  ): Promise<BenchmarkServerTimings | null>;
};

export type BenchmarkServerMetricsInput = {
  baseUrl: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  delay?: ((ms: number) => Promise<void>) | undefined;
};

export const VLLM_PREFILL_METRIC = "vllm:request_prefill_time_seconds";

const SETTLE_ATTEMPTS = 5;
const SETTLE_DELAY_MS = 60;

function parseSampleLine(line: string): { name: string; value: number } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const braceIndex = trimmed.indexOf("{");
  let name: string;
  let rest: string;
  if (braceIndex >= 0) {
    const closeIndex = trimmed.lastIndexOf("}");
    if (closeIndex < braceIndex) return null;
    name = trimmed.slice(0, braceIndex);
    rest = trimmed.slice(closeIndex + 1).trim();
  } else {
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex < 0) return null;
    name = trimmed.slice(0, spaceIndex);
    rest = trimmed.slice(spaceIndex + 1).trim();
  }
  const value = Number(rest.split(" ")[0]);
  return Number.isFinite(value) ? { name, value } : null;
}

export function parsePrometheusHistogramTotals(
  text: string,
  metricName: string,
): PrometheusHistogramTotals | null {
  let sumSeconds = 0;
  let count = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith(metricName)) continue;
    const sample = parseSampleLine(line);
    if (!sample) continue;
    if (sample.name === `${metricName}_sum`) {
      sumSeconds += sample.value;
      seen = true;
    } else if (sample.name === `${metricName}_count`) {
      count += sample.value;
      seen = true;
    }
  }
  return seen ? { sumSeconds, count } : null;
}

function timingsFromDelta(
  before: PrometheusHistogramTotals,
  after: PrometheusHistogramTotals,
): BenchmarkServerTimings | null {
  const countDelta = after.count - before.count;
  const sumDeltaMs = (after.sumSeconds - before.sumSeconds) * 1000;
  if (countDelta !== 1 || sumDeltaMs < 0) return null;
  return {
    promptN: null,
    promptMs: sumDeltaMs,
    predictedN: null,
    predictedMs: null,
    draftN: null,
    draftNAccepted: null,
  };
}

function vllmPrometheusSource(
  input: BenchmarkServerMetricsInput,
): BenchmarkServerMetricsSource {
  const delay = input.delay ?? sleep;
  const scrape = async (): Promise<PrometheusHistogramTotals | null> => {
    try {
      const response = await input.fetchImpl(`${input.baseUrl}/metrics`, {
        signal: input.signal,
      });
      if (!response.ok) return null;
      return parsePrometheusHistogramTotals(
        await response.text(),
        VLLM_PREFILL_METRIC,
      );
    } catch (error) {
      logger.debug(
        { baseUrl: input.baseUrl, error: (error as Error).message },
        "benchmark server metrics scrape failed",
      );
      return null;
    }
  };
  return {
    captureBefore: scrape,
    async requestTimings(before) {
      if (!before) return null;
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
        if (input.signal.aborted) return null;
        if (attempt > 0) await delay(SETTLE_DELAY_MS);
        const after = await scrape();
        if (!after) return null;
        if (after.count === before.count) continue;
        return timingsFromDelta(before, after);
      }
      return null;
    },
  };
}

const SOURCES: Record<
  EngineBenchmarkServerMetricsId,
  (input: BenchmarkServerMetricsInput) => BenchmarkServerMetricsSource | null
> = {
  none: () => null,
  "vllm-prometheus": vllmPrometheusSource,
};

export function benchmarkServerMetricsSource(
  id: EngineBenchmarkServerMetricsId,
  input: BenchmarkServerMetricsInput,
): BenchmarkServerMetricsSource | null {
  return SOURCES[id](input);
}
