import type {
  BenchmarkRunProgress,
  BenchmarkStreamEvent,
  BenchmarkTargetSnapshot,
  Instance,
} from "@arriero/core";

import { logger } from "../logger.js";
import type { LaunchSnapshot } from "../process/launch-snapshot.js";
import { asObject, numberOrNull } from "../proxy/json.js";
import { CANCELED_REQUEST_ERROR } from "./measure-client.js";
import { getBenchmarkRun, writeBenchmarkRunRecord } from "./repository.js";
import type { MeasuredRequest } from "./segmenter.js";

const activeProgress = new Map<string, BenchmarkRunProgress>();

export function getBenchmarkRunProgress(
  id: string,
): BenchmarkRunProgress | null {
  return activeProgress.get(id) ?? null;
}

export function setBenchmarkRunProgress(
  runId: string,
  progress: BenchmarkRunProgress,
): void {
  activeProgress.set(runId, progress);
}

export function clearBenchmarkRunProgress(runId: string): void {
  activeProgress.delete(runId);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export type BenchmarkEndpointProbe = {
  baseUrl: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
};

export async function resolveEndpointModel(
  probe: BenchmarkEndpointProbe,
): Promise<string | null> {
  let response: Response;
  try {
    response = await probe.fetchImpl(`${probe.baseUrl}/v1/models`, {
      signal: probe.signal,
    });
  } catch (error) {
    throw new Error(
      `instance endpoint is unreachable: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `instance endpoint is not ready: GET /v1/models returned ${response.status}`,
    );
  }
  const body = asObject(await response.json().catch(() => null));
  const data = Array.isArray(body?.data) ? body.data : [];
  const first = asObject(data[0]);
  return typeof first?.id === "string" ? first.id : null;
}

export type BenchmarkServerProps = {
  totalSlots: number | null;
  buildInfo: string | null;
};

export async function fetchServerProps(
  probe: BenchmarkEndpointProbe,
): Promise<BenchmarkServerProps | null> {
  try {
    const response = await probe.fetchImpl(`${probe.baseUrl}/props`, {
      signal: probe.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    return {
      totalSlots: numberOrNull(body?.total_slots),
      buildInfo: typeof body?.build_info === "string" ? body.build_info : null,
    };
  } catch (error) {
    logger.debug(
      { baseUrl: probe.baseUrl, error: (error as Error).message },
      "benchmark props probe failed",
    );
    return null;
  }
}

export function benchmarkTargetSnapshot(input: {
  instance: Instance;
  runtimeArgs: Instance["args"];
  launch: LaunchSnapshot | null;
  baseUrl: string;
  model: string | null;
  buildInfo: string | null;
}): BenchmarkTargetSnapshot {
  const { instance, launch } = input;
  return {
    instanceName: instance.name,
    engineKind: instance.kind,
    baseUrl: input.baseUrl,
    model: input.model,
    binaryPath: instance.binaryPath || null,
    args: input.runtimeArgs,
    env: launch ? launch.env : instance.env,
    numa: launch ? launch.numa : (instance.numa ?? null),
    rpcWorkers: launch ? launch.rpcWorkers : instance.rpcWorkers,
    launchCliArgs: launch ? launch.cliArgs : null,
    buildInfo: input.buildInfo,
  };
}

export function persistRunRecord(runId: string): void {
  const run = getBenchmarkRun(runId);
  if (!run) {
    logger.warn({ runId }, "benchmark run record missing after finalize");
    return;
  }
  writeBenchmarkRunRecord(run);
}

export function benchmarkStreamEvents(
  measured: readonly MeasuredRequest[],
): BenchmarkStreamEvent[] {
  const events: BenchmarkStreamEvent[] = [];
  for (const request of measured) {
    events.push({
      requestId: request.requestId,
      tMs: request.submitMs,
      kind: "submit",
    });
    if (request.firstTokenMs !== null) {
      events.push({
        requestId: request.requestId,
        tMs: request.firstTokenMs,
        kind: "first-token",
      });
    }
    for (const chunkMs of request.chunkTimesMs) {
      events.push({
        requestId: request.requestId,
        tMs: chunkMs,
        kind: "chunk",
      });
    }
    const endMs = request.endedMs ?? request.doneMs ?? request.submitMs;
    events.push(
      request.error !== null
        ? {
            requestId: request.requestId,
            tMs: endMs,
            kind: "error",
            message: request.error,
          }
        : { requestId: request.requestId, tMs: endMs, kind: "done" },
    );
  }
  return events;
}

export function describeRequestFailures(
  measured: readonly Pick<MeasuredRequest, "error">[],
): { count: number; message: string } | null {
  const failedMessages = measured.flatMap((request) =>
    request.error !== null && request.error !== CANCELED_REQUEST_ERROR
      ? [request.error]
      : [],
  );
  if (failedMessages.length === 0) return null;
  const distinct = [...new Set(failedMessages)];
  return {
    count: failedMessages.length,
    message: `${failedMessages.length} of ${measured.length} requests failed: ${distinct.join("; ")}`,
  };
}
