import {
  ApiProxyRequestTraceSchema,
  ApiProxySchedulerActionSchema,
  type ApiProxyRequestTrace,
  type FleetNode,
} from "@arriero/core";

import { logger } from "../logger.js";
import { fetchNodeJson } from "../nodes/remote.js";
import { sleep } from "../utils/sleep.js";
import type { ProxyTraceAccumulator } from "./protocol-trace.js";

export const delegatedTraceHeader = "x-arriero-trace-id";

const FETCH_TIMEOUT_MS = 4000;
const RETRY_DELAYS_MS = [400, 900, 1800];

export function withDelegatedTraceHeader(
  response: Response,
  traceId: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set(delegatedTraceHeader, traceId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export type DelegatedTraceFetchOnce = (
  node: FleetNode,
  traceId: string,
) => Promise<ApiProxyRequestTrace | null>;

async function fetchDelegatedTraceOnce(
  node: FleetNode,
  traceId: string,
): Promise<ApiProxyRequestTrace | null> {
  try {
    const raw = await fetchNodeJson<unknown>(
      node,
      `proxy/traces/${encodeURIComponent(traceId)}`,
      FETCH_TIMEOUT_MS,
    );
    return ApiProxyRequestTraceSchema.parse(raw);
  } catch {
    return null;
  }
}

export async function fetchDelegatedTrace(
  node: FleetNode,
  traceId: string,
  options: {
    delays?: number[] | undefined;
    fetchOnce?: DelegatedTraceFetchOnce | undefined;
  } = {},
): Promise<ApiProxyRequestTrace | null> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const fetchOnce = options.fetchOnce ?? fetchDelegatedTraceOnce;
  for (let attempt = 0; ; attempt += 1) {
    const trace = await fetchOnce(node, traceId);
    if (trace) {
      return trace;
    }
    const delay = delays[attempt];
    if (delay === undefined) {
      logger.warn(
        { nodeId: node.id, traceId },
        "delegated trace unavailable after retries",
      );
      return null;
    }
    await sleep(delay);
  }
}

export function recordDelegatedTrace(input: {
  node: FleetNode;
  traceId: string;
  trace: ProxyTraceAccumulator;
  record: () => void;
}): void {
  void fetchDelegatedTrace(input.node, input.traceId)
    .then((remote) => {
      if (remote) {
        mergeDelegatedTrace(input.trace, remote);
      }
    })
    .finally(input.record);
}

export function mergeDelegatedTrace(
  trace: ProxyTraceAccumulator,
  remote: ApiProxyRequestTrace,
): void {
  trace.translated = trace.translated || remote.translated;
  trace.resumed = trace.resumed || remote.resumed;
  trace.slotId ??= remote.slotId;
  trace.cacheOrigin ??= remote.cacheOrigin;
  trace.queueMs ??= remote.queueMs;
  trace.ttftMs ??= remote.ttftMs;
  trace.errorCode ??= remote.errorCode;
  trace.errorMessage ??= remote.errorMessage;
  if (trace.streamHealth === null && remote.streamHealth) {
    trace.streamHealth = { ...remote.streamHealth };
  }
  if (trace.schedulerActions.length === 0) {
    trace.schedulerActions = remote.schedulerActions.flatMap((action) => {
      const parsed = ApiProxySchedulerActionSchema.safeParse(action);
      return parsed.success ? [parsed.data] : [];
    });
  }
  if (trace.displacedTargetIds.length === 0) {
    trace.displacedTargetIds = [...remote.displacedTargetIds];
  }
  if (trace.translationWarnings.length === 0) {
    trace.translationWarnings = [...remote.translationWarnings];
  }
  if (!remote.usage) {
    return;
  }
  if (!trace.usage) {
    trace.usage = { ...remote.usage };
    return;
  }
  const usage = trace.usage;
  usage.promptTokens = remote.usage.promptTokens ?? usage.promptTokens;
  usage.cacheReadTokens = remote.usage.cacheReadTokens ?? usage.cacheReadTokens;
  usage.cacheCreationTokens =
    remote.usage.cacheCreationTokens ?? usage.cacheCreationTokens;
  if (remote.usage.completionTokens > 0) {
    usage.completionTokens = remote.usage.completionTokens;
  }
  if (remote.usage.genMs > 0) {
    usage.genMs = remote.usage.genMs;
    usage.ratePerSecond = remote.usage.ratePerSecond ?? usage.ratePerSecond;
  }
  usage.prefillMs = remote.usage.prefillMs ?? usage.prefillMs;
  usage.promptPerSecond = remote.usage.promptPerSecond ?? usage.promptPerSecond;
}
