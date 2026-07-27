import {
  ApiProxyStatsSnapshotSchema,
  type ApiProxyRequestTrace,
  type ApiProxyStatsBucket,
  type ApiProxyStatsModelEntry,
  type ApiProxyStatsSnapshot,
  type ApiProxyStatsTotals,
} from "@arriero/core";

const MAX_HOURS = 24;
const MAX_TRACES = 50;

type MutableCounters = {
  requests: number;
  errors: number;
  cacheHits: number;
  resumed: number;
  completionTokens: number;
  promptTokens: number;
  genMs: number;
  requestsWithTokens: number;
};

type MutableBucket = MutableCounters & {
  hour: string;
  byModel: Map<string, MutableCounters>;
};

function emptyCounters(): MutableCounters {
  return {
    requests: 0,
    errors: 0,
    cacheHits: 0,
    resumed: 0,
    completionTokens: 0,
    promptTokens: 0,
    genMs: 0,
    requestsWithTokens: 0,
  };
}

function applyTrace(target: MutableCounters, trace: ApiProxyRequestTrace) {
  target.requests += 1;
  if (!trace.ok) {
    target.errors += 1;
  }
  if (trace.cache === "hit" || trace.cache === "coalesced") {
    target.cacheHits += 1;
  }
  if (trace.resumed) {
    target.resumed += 1;
  }
  if (trace.usage) {
    target.completionTokens += trace.usage.completionTokens;
    target.promptTokens += trace.usage.promptTokens ?? 0;
    target.genMs += trace.usage.genMs;
    target.requestsWithTokens += 1;
  }
}

function ratePerSecond(counters: MutableCounters): number | null {
  return counters.completionTokens > 0 && counters.genMs > 0
    ? counters.completionTokens / (counters.genMs / 1000)
    : null;
}

function toTotals(counters: MutableCounters): ApiProxyStatsTotals {
  return {
    requests: counters.requests,
    errors: counters.errors,
    cacheHits: counters.cacheHits,
    resumed: counters.resumed,
    completionTokens: counters.completionTokens,
    promptTokens: counters.promptTokens,
    genMs: counters.genMs,
    requestsWithTokens: counters.requestsWithTokens,
    ratePerSecond: ratePerSecond(counters),
  };
}

function toModelEntry(
  modelId: string,
  counters: MutableCounters,
): ApiProxyStatsModelEntry {
  return { modelId, ...toTotals(counters) };
}

function toBucket(bucket: MutableBucket): ApiProxyStatsBucket {
  return {
    hour: bucket.hour,
    ...toTotals(bucket),
    byModel: [...bucket.byModel.entries()]
      .map(([modelId, counters]) => toModelEntry(modelId, counters))
      .sort((left, right) => right.requests - left.requests),
  };
}

class ApiProxyStats {
  private traces: ApiProxyRequestTrace[] = [];
  private buckets = new Map<string, MutableBucket>();

  record(trace: ApiProxyRequestTrace): void {
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) {
      this.traces.splice(0, this.traces.length - MAX_TRACES);
    }

    const hour = trace.at.slice(0, 13);
    let bucket = this.buckets.get(hour);
    if (!bucket) {
      bucket = { hour, byModel: new Map(), ...emptyCounters() };
      this.buckets.set(hour, bucket);
    }
    applyTrace(bucket, trace);

    let modelCounters = bucket.byModel.get(trace.modelId);
    if (!modelCounters) {
      modelCounters = emptyCounters();
      bucket.byModel.set(trace.modelId, modelCounters);
    }
    applyTrace(modelCounters, trace);

    if (this.buckets.size > MAX_HOURS) {
      const oldest = [...this.buckets.keys()].sort()[0];
      if (oldest !== undefined) {
        this.buckets.delete(oldest);
      }
    }
  }

  snapshot(hours = MAX_HOURS): ApiProxyStatsSnapshot {
    const safeHours = Math.max(0, Math.min(hours, MAX_HOURS));
    const ordered = [...this.buckets.values()].sort((left, right) =>
      right.hour.localeCompare(left.hour),
    );
    const selected = ordered.slice(0, safeHours);

    const totals = emptyCounters();
    for (const bucket of selected) {
      totals.requests += bucket.requests;
      totals.errors += bucket.errors;
      totals.cacheHits += bucket.cacheHits;
      totals.resumed += bucket.resumed;
      totals.completionTokens += bucket.completionTokens;
      totals.promptTokens += bucket.promptTokens;
      totals.genMs += bucket.genMs;
      totals.requestsWithTokens += bucket.requestsWithTokens;
    }

    return ApiProxyStatsSnapshotSchema.parse({
      generatedAt: new Date().toISOString(),
      hours: safeHours,
      totals: toTotals(totals),
      buckets: selected.map(toBucket),
    });
  }

  recentTraces(limit = MAX_TRACES): ApiProxyRequestTrace[] {
    const safeLimit = Math.max(0, Math.min(limit, MAX_TRACES));
    return this.traces.slice(-safeLimit).reverse();
  }

  reset(): void {
    this.traces = [];
    this.buckets.clear();
  }
}

export const apiProxyStats = new ApiProxyStats();
