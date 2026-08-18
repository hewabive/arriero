import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkServerMetricsSource,
  parsePrometheusHistogramTotals,
  VLLM_PREFILL_METRIC,
} from "./server-metrics.js";

function metricsText(entries: Array<{ sum: number; count: number }>): string {
  const lines = [
    "# HELP vllm:request_prefill_time_seconds Histogram of time spent in PREFILL phase.",
    "# TYPE vllm:request_prefill_time_seconds histogram",
  ];
  for (const [index, entry] of entries.entries()) {
    lines.push(
      `vllm:request_prefill_time_seconds_bucket{model_name="m",le="1.0",engine="${index}"} ${entry.count}`,
      `vllm:request_prefill_time_seconds_sum{model_name="m",engine="${index}"} ${entry.sum}`,
      `vllm:request_prefill_time_seconds_count{model_name="m",engine="${index}"} ${entry.count}`,
    );
  }
  lines.push('vllm:num_requests_running{model_name="m"} 0');
  return lines.join("\n");
}

function fetchReturning(bodies: string[]): typeof fetch {
  let call = 0;
  return async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(body, { status: 200 });
  };
}

const abortless = new AbortController().signal;

test("parsePrometheusHistogramTotals sums series across label sets", () => {
  const totals = parsePrometheusHistogramTotals(
    metricsText([
      { sum: 1.5, count: 3 },
      { sum: 0.5, count: 1 },
    ]),
    VLLM_PREFILL_METRIC,
  );
  assert.deepEqual(totals, { sumSeconds: 2, count: 4 });
});

test("parsePrometheusHistogramTotals returns null for a missing metric", () => {
  assert.equal(
    parsePrometheusHistogramTotals(
      metricsText([{ sum: 1, count: 1 }]),
      "vllm:request_queue_time_seconds",
    ),
    null,
  );
  assert.equal(parsePrometheusHistogramTotals("", VLLM_PREFILL_METRIC), null);
});

test("the none source id yields no metrics source", () => {
  assert.equal(
    benchmarkServerMetricsSource("none", {
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: fetchReturning([""]),
      signal: abortless,
    }),
    null,
  );
});

test("vllm source derives promptMs from a single-request delta", async () => {
  const source = benchmarkServerMetricsSource("vllm-prometheus", {
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: fetchReturning([
      metricsText([{ sum: 1.5, count: 3 }]),
      metricsText([{ sum: 2.1, count: 4 }]),
    ]),
    signal: abortless,
  });
  assert.ok(source);
  const before = await source.captureBefore();
  const timings = await source.requestTimings(before);
  assert.ok(timings);
  assert.ok(Math.abs((timings.promptMs ?? 0) - 600) < 1e-6);
  assert.equal(timings.promptN, null);
  assert.equal(timings.draftN, null);
});

test("vllm source retries until the finished request lands in the histogram", async () => {
  const delays: number[] = [];
  const source = benchmarkServerMetricsSource("vllm-prometheus", {
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: fetchReturning([
      metricsText([{ sum: 1, count: 2 }]),
      metricsText([{ sum: 1, count: 2 }]),
      metricsText([{ sum: 1.25, count: 3 }]),
    ]),
    signal: abortless,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  assert.ok(source);
  const timings = await source.requestTimings(await source.captureBefore());
  assert.ok(Math.abs((timings?.promptMs ?? 0) - 250) < 1e-6);
  assert.equal(delays.length, 1);
});

test("vllm source discards deltas it cannot attribute to one request", async () => {
  const interfered = benchmarkServerMetricsSource("vllm-prometheus", {
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: fetchReturning([
      metricsText([{ sum: 1, count: 2 }]),
      metricsText([{ sum: 3, count: 4 }]),
    ]),
    signal: abortless,
  });
  assert.ok(interfered);
  assert.equal(
    await interfered.requestTimings(await interfered.captureBefore()),
    null,
  );

  const reset = benchmarkServerMetricsSource("vllm-prometheus", {
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: fetchReturning([
      metricsText([{ sum: 5, count: 9 }]),
      metricsText([{ sum: 0.2, count: 10 }]),
    ]),
    signal: abortless,
  });
  assert.ok(reset);
  assert.equal(await reset.requestTimings(await reset.captureBefore()), null);
});

test("vllm source degrades to null when the endpoint has no metric", async () => {
  const source = benchmarkServerMetricsSource("vllm-prometheus", {
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: async () => new Response("not found", { status: 404 }),
    signal: abortless,
  });
  assert.ok(source);
  const before = await source.captureBefore();
  assert.equal(before, null);
  assert.equal(await source.requestTimings(before), null);
});

test("vllm source gives up after bounded settle attempts", async () => {
  let scrapes = 0;
  const source = benchmarkServerMetricsSource("vllm-prometheus", {
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: async () => {
      scrapes += 1;
      return new Response(metricsText([{ sum: 1, count: 2 }]), {
        status: 200,
      });
    },
    signal: abortless,
    delay: async () => {},
  });
  assert.ok(source);
  const before = await source.captureBefore();
  assert.equal(await source.requestTimings(before), null);
  assert.equal(scrapes, 6);
});
