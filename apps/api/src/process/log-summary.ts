import type {
  Instance,
  InstanceKind,
  InstanceLogSummary,
  InstanceMemoryLayout,
  RuntimeState,
} from "@arriero/core";

import { statSync } from "node:fs";

import {
  emptyMemoryLayout,
  engineLogParser,
  loadProgress,
  pendingLoadProgress,
  type EngineLogParseResult,
} from "./log-parsers/index.js";
import { latestProcessRun, type ProcessRun } from "./runs-repository.js";
import { getRuntimeMemoryLayout } from "./runtime-memory.js";
import { readTailLines } from "../utils/log-tail.js";

const MAX_SUMMARY_LINES = 1_000;

type ParsedLogTail = {
  size: number;
  mtimeMs: number;
  lines: string[];
  parsed: EngineLogParseResult;
};

const parsedLogTails = new Map<string, ParsedLogTail>();
const PARSED_LOG_TAIL_LIMIT = 64;

function parseLogTail(
  logPath: string,
  kind: InstanceKind,
  cudaDevicesDisabled: boolean,
): ParsedLogTail {
  const stat = statSync(logPath);
  const key = `${logPath}\0${kind}\0${cudaDevicesDisabled}`;
  const cached = parsedLogTails.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }
  const { lines } = readTailLines(logPath, MAX_SUMMARY_LINES);
  const parsed = engineLogParser(kind).parse({ lines, cudaDevicesDisabled });
  if (parsedLogTails.size >= PARSED_LOG_TAIL_LIMIT) {
    parsedLogTails.clear();
  }
  const entry = { size: stat.size, mtimeMs: stat.mtimeMs, lines, parsed };
  parsedLogTails.set(key, entry);
  return entry;
}

const runtimeStatuses = new Set<RuntimeState["status"]>([
  "stopped",
  "starting",
  "running",
  "stopping",
  "exited",
  "stale",
  "error",
]);

function nowIso() {
  return new Date().toISOString();
}

function isRuntimeStatus(
  value: string | null | undefined,
): value is RuntimeState["status"] {
  return Boolean(value && runtimeStatuses.has(value as RuntimeState["status"]));
}

function runtimeFromLatestRun(
  instanceId: string,
  latestRun: ReturnType<typeof latestProcessRun>,
): RuntimeState | undefined {
  if (!latestRun) {
    return undefined;
  }

  const pid = latestRun.pid ? Number(latestRun.pid) : null;
  const exitCode =
    latestRun.exitCode === null || latestRun.exitCode === undefined
      ? null
      : Number(latestRun.exitCode);

  return {
    instanceId,
    pid: pid && Number.isFinite(pid) ? pid : null,
    status: isRuntimeStatus(latestRun.status) ? latestRun.status : "stopped",
    startedAt: latestRun.startedAt,
    stoppedAt: latestRun.stoppedAt,
    exitCode: exitCode === null || Number.isFinite(exitCode) ? exitCode : null,
    logPath: latestRun.logPath,
    rawLogPath: latestRun.rawLogPath,
  };
}

export function instanceCudaDevicesDisabled(instance: Instance) {
  const raw = instance.env?.CUDA_VISIBLE_DEVICES;
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim();
  return normalized === "" || normalized === "-1";
}

async function resolveMemoryLayout(input: {
  parsed: EngineLogParseResult;
  lines: string[];
  runtime: RuntimeState | undefined;
  kind: InstanceKind;
}): Promise<InstanceMemoryLayout> {
  if (input.parsed.memoryLayout.totalBytes > 0) {
    return input.parsed.memoryLayout;
  }
  return (
    (await getRuntimeMemoryLayout({
      runtime: input.runtime,
      lines: input.lines,
      baseLayout: input.parsed.memoryLayout,
      kind: input.kind,
    })) ?? input.parsed.memoryLayout
  );
}

export async function summarizeInstanceLog(input: {
  instanceId: string;
  kind: InstanceKind;
  runtime: RuntimeState | undefined;
  cudaDevicesDisabled?: boolean;
}): Promise<InstanceLogSummary> {
  let latestRun: ProcessRun | null | undefined;
  const resolveLatestRun = () => {
    if (latestRun === undefined) {
      latestRun = latestProcessRun(input.instanceId);
    }
    return latestRun;
  };
  const runtime =
    input.runtime ?? runtimeFromLatestRun(input.instanceId, resolveLatestRun());
  const logPath = runtime?.logPath ?? resolveLatestRun()?.logPath ?? null;

  if (!logPath) {
    return {
      instanceId: input.instanceId,
      logPath: null,
      listeningUrl: null,
      modelPath: null,
      modelAlias: null,
      contextSize: null,
      gpuLayers: null,
      slots: null,
      ready: false,
      warnings: [],
      errors: [],
      notices: [],
      loadProgress: pendingLoadProgress(),
      memoryLayout: emptyMemoryLayout(),
      updatedAt: nowIso(),
    };
  }

  try {
    const { lines, parsed } = parseLogTail(
      logPath,
      input.kind,
      input.cudaDevicesDisabled ?? false,
    );
    const memoryLayout = await resolveMemoryLayout({
      parsed,
      lines,
      runtime,
      kind: input.kind,
    });
    return {
      instanceId: input.instanceId,
      logPath,
      ...parsed,
      memoryLayout,
      updatedAt: nowIso(),
    };
  } catch (error) {
    return {
      instanceId: input.instanceId,
      logPath,
      listeningUrl: null,
      modelPath: null,
      modelAlias: null,
      contextSize: null,
      gpuLayers: null,
      slots: null,
      ready: false,
      warnings: [],
      errors: [`Unable to parse log file: ${(error as Error).message}`],
      notices: [],
      loadProgress: loadProgress(
        "error",
        null,
        `Unable to parse log file: ${(error as Error).message}`,
        false,
      ),
      memoryLayout: emptyMemoryLayout(),
      updatedAt: nowIso(),
    };
  }
}
