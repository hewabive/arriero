import type { ApiProxyRequestTrace } from "@arriero/core";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { CAPTURE_REQUEST_FILE_KIND } from "../proxy/pipeline.js";
import { readApiProxyRequestFile } from "../proxy/request-files.js";
import {
  apiProxyTraceRetentionCutoff,
  listApiProxyTracesForIndexing,
} from "../proxy/traces-repository.js";
import { startAsyncIntervalLoop } from "../utils/interval-loop.js";
import {
  WORKLOAD_NORMALIZATION_VERSION,
  WORKLOAD_REPLAYABLE_ENDPOINTS,
  classifyWorkloadOutcome,
  workloadCacheMetrics,
  workloadCaptureFile,
  workloadChain,
  workloadClientSessionId,
  workloadRecordIssue,
  workloadThinkTimeMs,
} from "./record-analysis.js";
import {
  clearWorkloadRecords,
  findWorkloadParent,
  insertWorkloadRecord,
  latestWorkloadSessionRecordBefore,
  newestWorkloadRecordAt,
  pruneWorkloadRecords,
  readWorkloadIndexState,
  writeWorkloadIndexState,
} from "./repository.js";

const INDEX_INTERVAL_MS = 60_000;
const WORKLOAD_INDEX_SETTLE_MS = 60_000;
const WORKLOAD_INDEX_TRAILING_WINDOW_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_RECORDS_PER_PASS = 5000;

export type WorkloadIndexPassResult = {
  indexed: number;
  pruned: number;
  rebuilt: boolean;
};

function traceEndAt(trace: ApiProxyRequestTrace): string {
  return new Date(Date.parse(trace.at) + trace.durationMs).toISOString();
}

function indexWorkloadTrace(trace: ApiProxyRequestTrace): void {
  const file = workloadCaptureFile(trace);
  const captured = file ? readApiProxyRequestFile(file.path) : null;
  const protocol = captured?.protocol ?? trace.protocol;
  const endpoint = captured?.endpoint ?? trace.endpoint;
  const issue = captured
    ? workloadRecordIssue({ trace, protocol, endpoint, body: captured.data })
    : "capture-unreadable";
  const chain =
    captured && WORKLOAD_REPLAYABLE_ENDPOINTS[protocol] === endpoint
      ? workloadChain(protocol, captured.data)
      : null;
  const promptTokens = trace.usage?.promptTokens ?? null;
  const cacheReadTokens = trace.usage?.cacheReadTokens ?? null;
  const parent = chain
    ? findWorkloadParent({
        sourceId: trace.sourceId,
        modelId: trace.modelId,
        chain: chain.chain,
        before: trace.at,
      })
    : null;
  const sessionId = parent?.sessionId ?? trace.id;
  const previous = parent
    ? latestWorkloadSessionRecordBefore(sessionId, trace.at)
    : null;
  const metrics = parent
    ? workloadCacheMetrics(parent, {
        targetId: trace.targetId,
        cacheReadTokens,
      })
    : { cacheLossTokens: null, responseReuseTokens: null };
  insertWorkloadRecord({
    traceId: trace.id,
    at: trace.at,
    endAt: traceEndAt(trace),
    durationMs: trace.durationMs,
    sourceId: trace.sourceId,
    sourceName: trace.sourceName,
    modelId: trace.modelId,
    targetId: trace.targetId,
    targetName: trace.targetName,
    protocol,
    endpoint,
    outcome: classifyWorkloadOutcome(trace),
    issue,
    capturePath: file?.path ?? null,
    messageCount: chain?.messageCount ?? null,
    chainKey: chain?.key ?? null,
    sessionId,
    parentTraceId: parent?.traceId ?? null,
    sharedMessages: parent?.messageCount ?? null,
    clientSessionId: captured ? workloadClientSessionId(captured.data) : null,
    promptTokens,
    cacheReadTokens,
    completionTokens: trace.usage ? trace.usage.completionTokens : null,
    ttftMs: trace.ttftMs,
    thinkTimeMs: workloadThinkTimeMs(previous, trace.at),
    cacheLossTokens: metrics.cacheLossTokens,
    responseReuseTokens: metrics.responseReuseTokens,
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
  });
}

function scanStart(cutoff: string, rebuilt: boolean): string {
  const newest = rebuilt ? null : newestWorkloadRecordAt();
  if (newest === null) {
    return cutoff;
  }
  const trailing = new Date(
    Date.parse(newest) - WORKLOAD_INDEX_TRAILING_WINDOW_MS,
  ).toISOString();
  return trailing > cutoff ? trailing : cutoff;
}

export async function runWorkloadIndexPass(
  now = new Date(),
): Promise<WorkloadIndexPassResult> {
  const rebuilt =
    readWorkloadIndexState().normalizationVersion !==
    WORKLOAD_NORMALIZATION_VERSION;
  if (rebuilt) {
    clearWorkloadRecords();
  }
  const cutoff = apiProxyTraceRetentionCutoff(now);
  const pruned = pruneWorkloadRecords(cutoff);
  const settledBefore = now.getTime() - WORKLOAD_INDEX_SETTLE_MS;
  const from = scanStart(cutoff, rebuilt);
  let after: { at: string; id: string } | null = null;
  let indexed = 0;
  while (indexed < MAX_RECORDS_PER_PASS) {
    const page = listApiProxyTracesForIndexing({
      from,
      after,
      fileKind: CAPTURE_REQUEST_FILE_KIND,
      limit: PAGE_SIZE,
    });
    for (const trace of page.traces) {
      if (Date.parse(trace.at) + trace.durationMs > settledBefore) {
        continue;
      }
      indexWorkloadTrace(trace);
      indexed += 1;
      await yieldToEventLoop();
      if (indexed >= MAX_RECORDS_PER_PASS) {
        break;
      }
    }
    if (!page.next) {
      break;
    }
    after = page.next;
  }
  writeWorkloadIndexState({
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
    lastPassAt: now.toISOString(),
    lastPassIndexed: indexed,
  });
  return { indexed, pruned, rebuilt };
}

export function startWorkloadIndexLoop(options: {
  onError?: (error: unknown) => void;
}): () => void {
  return startAsyncIntervalLoop(() => runWorkloadIndexPass(), {
    intervalMs: INDEX_INTERVAL_MS,
    immediate: true,
    onError: options.onError,
  });
}
