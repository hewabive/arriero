import {
  apiProxyInflightPhaseEnded,
  type ApiProxyActivityModel,
  type ApiProxyActivitySnapshot,
  type ApiProxyActivitySource,
} from "@arriero/core";

import { apiProxyInflight, type ApiProxyInflightRegistry } from "./inflight.js";
import { aggregateApiProxyTraceActivity } from "./traces-repository.js";

const API_PROXY_ACTIVITY_WINDOW_MINUTES = 60;

type ModelAccumulator = {
  model: ApiProxyActivityModel;
  sources: Map<string, ApiProxyActivitySource>;
};

function compareModels(a: ApiProxyActivityModel, b: ApiProxyActivityModel) {
  if (a.requests !== b.requests) {
    return b.requests - a.requests;
  }
  return a.modelId.localeCompare(b.modelId);
}

function compareSources(a: ApiProxyActivitySource, b: ApiProxyActivitySource) {
  if (a.requests !== b.requests) {
    return b.requests - a.requests;
  }
  return (a.sourceName ?? "").localeCompare(b.sourceName ?? "");
}

export function getApiProxyActivity(
  options: { now?: Date; inflight?: ApiProxyInflightRegistry } = {},
): ApiProxyActivitySnapshot {
  const now = options.now ?? new Date();
  const registry = options.inflight ?? apiProxyInflight;
  const fromIso = new Date(
    now.getTime() - API_PROXY_ACTIVITY_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const accumulators = new Map<string, ModelAccumulator>();
  const modelEntry = (modelId: string): ModelAccumulator => {
    const existing = accumulators.get(modelId);
    if (existing) {
      return existing;
    }
    const created: ModelAccumulator = {
      model: {
        modelId,
        requests: 0,
        errors: 0,
        activeRequests: 0,
        queuedRequests: 0,
        sources: [],
      },
      sources: new Map(),
    };
    accumulators.set(modelId, created);
    return created;
  };
  const sourceEntry = (
    accumulator: ModelAccumulator,
    sourceId: string | null,
    sourceName: string | null,
  ): ApiProxyActivitySource => {
    const key = sourceId ?? "";
    const existing = accumulator.sources.get(key);
    if (existing) {
      existing.sourceName ??= sourceName;
      return existing;
    }
    const created: ApiProxyActivitySource = {
      sourceId,
      sourceName,
      requests: 0,
      errors: 0,
      activeRequests: 0,
    };
    accumulator.sources.set(key, created);
    return created;
  };

  for (const row of aggregateApiProxyTraceActivity(fromIso)) {
    const accumulator = modelEntry(row.modelId);
    accumulator.model.requests += row.requests;
    accumulator.model.errors += row.errors;
    const source = sourceEntry(accumulator, row.sourceId, row.sourceName);
    source.requests += row.requests;
    source.errors += row.errors;
  }

  for (const [modelId, requests] of registry.snapshotByModel()) {
    for (const view of requests) {
      if (apiProxyInflightPhaseEnded(view.phase)) {
        continue;
      }
      const accumulator = modelEntry(modelId);
      const source = sourceEntry(accumulator, view.sourceId, view.sourceName);
      if (view.phase === "queued") {
        accumulator.model.queuedRequests += 1;
      } else {
        accumulator.model.activeRequests += 1;
        source.activeRequests += 1;
      }
    }
  }

  const models = [...accumulators.values()]
    .map((accumulator) => ({
      ...accumulator.model,
      sources: [...accumulator.sources.values()].sort(compareSources),
    }))
    .sort(compareModels);

  return {
    generatedAt: now.toISOString(),
    windowMinutes: API_PROXY_ACTIVITY_WINDOW_MINUTES,
    models,
  };
}
