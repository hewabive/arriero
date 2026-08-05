import type {
  Instance,
  InstanceKind,
  InstanceMemoryLayout,
  InstanceMemoryPlacement,
  NumaPlacement,
  RuntimeState,
} from "@arriero/core";
import { engineDescriptor } from "@arriero/core";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";

import { computeNumaPlacement, parseNumaMaps } from "../numa/placement.js";
import { numaIsApplicable, readNumaTopology } from "../numa/topology.js";
import {
  nvidiaTelemetry,
  type NvidiaComputeProcess,
} from "../nvidia/telemetry.js";
import {
  compareMemoryPlacements,
  emptyMemoryPlacement,
} from "./memory-placement.js";
import { isPidAlive } from "./pid.js";

const execFileAsync = promisify(execFile);

const KIB = 1024;
const TELEMETRY_CACHE_MS = 2_000;
const PS_TIMEOUT_MS = 1_000;

type ProcessInfo = {
  pid: number;
  ppid: number | null;
  command: string;
  args: string;
};

export type ProcMemoryUsage = {
  pid: number;
  anonBytes: number;
  fileBytes: number;
};

export function createStaleWhileRevalidate<T>(
  fetcher: () => Promise<T>,
  options: { ttlMs: number; empty: T },
): { get: () => T } {
  let snapshot: { data: T } | null = null;
  let lastAttemptAt = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = () => {
    if (inFlight) {
      return;
    }
    lastAttemptAt = Date.now();
    inFlight = fetcher()
      .then((data) => {
        snapshot = { data };
      })
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    get() {
      if (Date.now() - lastAttemptAt >= options.ttlMs) {
        refresh();
      }
      return snapshot?.data ?? options.empty;
    },
  };
}

function kibToBytes(value: string) {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed * KIB)
    : null;
}

function basename(command: string) {
  return command.trim().split(/[\\/]/).pop() ?? command.trim();
}

function parsePositivePid(value: string | undefined) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isLikelyLlamaServer(processInfo: ProcessInfo) {
  const commandName = basename(processInfo.command).toLowerCase();
  const firstArg = basename(processInfo.args.trim().split(/\s+/)[0] ?? "");
  return (
    commandName.includes("llama-server") ||
    firstArg.toLowerCase().includes("llama-server")
  );
}

export function isManagedDescendant(
  kind: InstanceKind,
  processInfo: Pick<ProcessInfo, "command" | "args">,
) {
  const policy = engineDescriptor(kind).processTree;
  if (policy === "all-descendants") return true;
  if (policy === "root-only") return false;
  return isLikelyLlamaServer({ ...processInfo, pid: 0, ppid: null });
}

export function parsePsOutput(stdout: string): ProcessInfo[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line): ProcessInfo[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) {
        return [];
      }
      const pid = parsePositivePid(match[1]);
      if (pid === null) {
        return [];
      }
      return [
        {
          pid,
          ppid: Number.isInteger(Number(match[2])) ? Number(match[2]) : null,
          command: match[3] ?? "",
          args: match[4] ?? "",
        },
      ];
    });
}

async function readProcessTable(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-eo", "pid=,ppid=,comm=,args="],
    {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  return parsePsOutput(stdout);
}

const processTable = createStaleWhileRevalidate(readProcessTable, {
  ttlMs: TELEMETRY_CACHE_MS,
  empty: [] as ProcessInfo[],
});

function cachedProcessTable(): ProcessInfo[] {
  return processTable.get();
}

export function parseProcStatusRss(
  contents: string,
): Omit<ProcMemoryUsage, "pid"> | null {
  const values = new Map<string, number>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^(RssAnon|RssFile|RssShmem):\s+(\d+)\s+kB$/i.exec(
      line.trim(),
    );
    if (!match) {
      continue;
    }
    const bytes = kibToBytes(match[2] ?? "");
    if (bytes !== null) {
      values.set(match[1]!.toLowerCase(), bytes);
    }
  }

  const anon = values.get("rssanon");
  const file = values.get("rssfile");
  if (anon === undefined && file === undefined) {
    return null;
  }
  return {
    anonBytes: (anon ?? 0) + (values.get("rssshmem") ?? 0),
    fileBytes: file ?? 0,
  };
}

export function parseProcStatusSwap(contents: string): number | null {
  const match = /^\s*VmSwap:\s+(\d+)\s+kB\s*$/im.exec(contents);
  return match ? kibToBytes(match[1] ?? "") : null;
}

function readProcSwap(pid: number): number | null {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    return parseProcStatusSwap(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return null;
  }
}

export async function getInstanceSwapBytes(
  runtime: RuntimeState | undefined,
  kind: InstanceKind = "llama-server",
): Promise<number | null> {
  const pids = await candidatePids({ runtime, lines: [], kind });
  let total: number | null = null;
  for (const pid of pids) {
    const swapBytes = readProcSwap(pid);
    if (swapBytes !== null) {
      total = (total ?? 0) + swapBytes;
    }
  }
  return total;
}

function readProcNumaMaps(pid: number): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    return readFileSync(`/proc/${pid}/numa_maps`, "utf8");
  } catch {
    return null;
  }
}

const NUMA_PLACEMENT_CACHE_LIMIT = 128;
const numaPlacementCache = new Map<string, NumaPlacement>();

function rememberNumaPlacement(key: string, placement: NumaPlacement) {
  numaPlacementCache.set(key, placement);
  while (numaPlacementCache.size > NUMA_PLACEMENT_CACHE_LIMIT) {
    const oldest = numaPlacementCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    numaPlacementCache.delete(oldest);
  }
}

export async function getInstanceNumaPlacement(input: {
  instance: Instance;
  runtime: RuntimeState | undefined;
  runId: string | null;
}): Promise<NumaPlacement | null> {
  const numa = input.instance.numa;
  if (process.platform !== "linux" || numa?.mode !== "interleave") {
    return null;
  }

  const topology = readNumaTopology();
  if (!numaIsApplicable(topology)) {
    return null;
  }
  const interleaveNodeCount =
    numa.nodes.length > 0 ? numa.nodes.length : topology.length;
  if (interleaveNodeCount <= 1) {
    return null;
  }

  const cacheKey =
    input.runId ?? (input.runtime?.pid ? `pid:${input.runtime.pid}` : null);
  if (cacheKey) {
    const cached = numaPlacementCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const pids = await candidatePids({
    runtime: input.runtime,
    lines: [],
    kind: input.instance.kind,
  });
  if (pids.length === 0) {
    return null;
  }

  const perNodeBytes = new Map<number, number>();
  let measured = false;
  for (const pid of pids) {
    const content = readProcNumaMaps(pid);
    if (content === null) {
      continue;
    }
    measured = true;
    for (const [node, bytes] of parseNumaMaps(content)) {
      perNodeBytes.set(node, (perNodeBytes.get(node) ?? 0) + bytes);
    }
  }
  if (!measured) {
    return null;
  }

  const placement = computeNumaPlacement({ perNodeBytes, interleaveNodeCount });
  if (placement && cacheKey) {
    rememberNumaPlacement(cacheKey, placement);
  }
  return placement;
}

function readProcMemory(pid: number): ProcMemoryUsage | null {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const usage = parseProcStatusRss(
      readFileSync(`/proc/${pid}/status`, "utf8"),
    );
    return usage ? { pid, ...usage } : null;
  } catch {
    return null;
  }
}

function isOwnedByCurrentUser(pid: number): boolean {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    return true;
  }
  try {
    return statSync(`/proc/${pid}`).uid === process.getuid();
  } catch {
    return false;
  }
}

export function extractRouterChildPorts(lines: string[]) {
  const ports = new Set<number>();
  for (const line of lines) {
    const match =
      /\bspawning server instance with name=.* on port (\d+)\b/i.exec(line);
    if (!match) {
      continue;
    }
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }
  return [...ports];
}

function argsContainPort(args: string, port: number) {
  return new RegExp(`(?:^|\\s)(?:--port|-p)(?:=|\\s+)${port}(?:\\s|$)`).test(
    args,
  );
}

function descendantPids(processes: ProcessInfo[], rootPids: Set<number>) {
  const children = new Map<number, number[]>();
  for (const processInfo of processes) {
    if (processInfo.ppid === null) {
      continue;
    }
    const siblings = children.get(processInfo.ppid) ?? [];
    siblings.push(processInfo.pid);
    children.set(processInfo.ppid, siblings);
  }

  const descendants = new Set<number>();
  const queue = [...rootPids];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const child of children.get(parent) ?? []) {
      if (descendants.has(child)) {
        continue;
      }
      descendants.add(child);
      queue.push(child);
    }
  }
  return descendants;
}

async function candidatePids(input: {
  runtime: RuntimeState | undefined;
  lines: string[];
  kind: InstanceKind;
}): Promise<number[]> {
  const runtimeMayBeActive = [
    "starting",
    "running",
    "stopping",
    "stale",
  ].includes(input.runtime?.status ?? "");
  const candidates = new Set<number>();
  const rootPid = input.runtime?.pid ?? null;
  if (
    rootPid !== null &&
    Number.isInteger(rootPid) &&
    rootPid > 0 &&
    isPidAlive(rootPid)
  ) {
    candidates.add(rootPid);
  }

  const ports = runtimeMayBeActive ? extractRouterChildPorts(input.lines) : [];
  const processes = cachedProcessTable();
  if (processes.length === 0) {
    return [...candidates];
  }

  const descendants = descendantPids(processes, candidates);
  for (const processInfo of processes) {
    if (candidates.has(processInfo.pid)) {
      continue;
    }
    if (
      descendants.has(processInfo.pid) &&
      isManagedDescendant(input.kind, processInfo)
    ) {
      candidates.add(processInfo.pid);
      continue;
    }
    if (
      ports.some((port) => argsContainPort(processInfo.args, port)) &&
      input.kind === "llama-server" &&
      isLikelyLlamaServer(processInfo)
    ) {
      candidates.add(processInfo.pid);
    }
  }

  return [...candidates]
    .filter(isOwnedByCurrentUser)
    .sort((left, right) => left - right);
}

export type RuntimeMemoryObservation = {
  processIds: number[];
  deviceByIndex: { deviceIndex: number; bytes: number }[];
  anonBytes: number;
  fileBytes: number;
};

type RuntimeMemorySample = {
  processIds: number[];
  gpuProcesses: NvidiaComputeProcess[];
  processMemory: ProcMemoryUsage[];
};

async function sampleRuntimeMemory(input: {
  runtime: RuntimeState | undefined;
  lines: string[];
  kind: InstanceKind;
}): Promise<RuntimeMemorySample | null> {
  const pids = await candidatePids(input);
  if (pids.length === 0) {
    return null;
  }
  const pidSet = new Set(pids);
  const gpuProcesses = nvidiaTelemetry
    .computeProcesses()
    .filter((app) => pidSet.has(app.pid));
  const processMemory = pids
    .map(readProcMemory)
    .filter((usage): usage is ProcMemoryUsage => usage !== null);
  return { processIds: pids, gpuProcesses, processMemory };
}

export async function getRuntimeMemoryObservation(input: {
  runtime: RuntimeState | undefined;
  lines: string[];
  kind: InstanceKind;
}): Promise<RuntimeMemoryObservation | null> {
  const sample = await sampleRuntimeMemory(input);
  if (
    !sample ||
    (sample.gpuProcesses.length === 0 && sample.processMemory.length === 0)
  ) {
    return null;
  }
  const deviceBytes = new Map<number, number>();
  for (const app of sample.gpuProcesses) {
    deviceBytes.set(
      app.deviceIndex,
      (deviceBytes.get(app.deviceIndex) ?? 0) + app.usedMemoryBytes,
    );
  }
  return {
    processIds: sample.processIds,
    deviceByIndex: [...deviceBytes]
      .map(([deviceIndex, bytes]) => ({ deviceIndex, bytes }))
      .sort((left, right) => left.deviceIndex - right.deviceIndex),
    anonBytes: sample.processMemory.reduce(
      (sum, usage) => sum + usage.anonBytes,
      0,
    ),
    fileBytes: sample.processMemory.reduce(
      (sum, usage) => sum + usage.fileBytes,
      0,
    ),
  };
}

function layoutFromEntries(input: {
  entries: InstanceMemoryPlacement[];
  baseLayout: InstanceMemoryLayout;
  processIds: number[];
}): InstanceMemoryLayout {
  const entries = input.entries.sort(compareMemoryPlacements);

  return {
    source: "process-telemetry",
    sourceDetail:
      "Process-level runtime memory from NVIDIA NVML and /proc/<pid>/status: anon = committed RAM (KV cache, compute buffers), mmap file = reclaimable file-backed pages (mmapped model weights). Engine-specific buffer categories are not available from this source.",
    processIds: input.processIds,
    entries,
    deviceBytes: entries
      .filter((entry) => entry.kind === "device")
      .reduce((sum, entry) => sum + entry.totalBytes, 0),
    hostBytes: entries
      .filter((entry) => entry.kind === "host")
      .reduce((sum, entry) => sum + entry.totalBytes, 0),
    otherBytes: entries
      .filter((entry) => entry.kind === "other")
      .reduce((sum, entry) => sum + entry.totalBytes, 0),
    totalBytes: entries.reduce((sum, entry) => sum + entry.totalBytes, 0),
    projectedHostBytes: input.baseLayout.projectedHostBytes,
    projectedHostTotalBytes: input.baseLayout.projectedHostTotalBytes,
  };
}

export async function getRuntimeMemoryLayout(input: {
  runtime: RuntimeState | undefined;
  lines: string[];
  baseLayout: InstanceMemoryLayout;
  kind: InstanceKind;
}): Promise<InstanceMemoryLayout | null> {
  const sample = await sampleRuntimeMemory(input);
  if (!sample) {
    return null;
  }

  const gpuBytesByPid = new Map<
    number,
    { bytes: number; processNames: Set<string> }
  >();
  for (const app of sample.gpuProcesses) {
    const current = gpuBytesByPid.get(app.pid) ?? {
      bytes: 0,
      processNames: new Set<string>(),
    };
    current.bytes += app.usedMemoryBytes;
    if (app.processName) {
      current.processNames.add(basename(app.processName));
    }
    gpuBytesByPid.set(app.pid, current);
  }

  const entries: InstanceMemoryPlacement[] = [];
  for (const [pid, info] of gpuBytesByPid) {
    const names = [...info.processNames].sort();
    const suffix = names.length === 0 ? "" : ` (${names.join(", ")})`;
    const placement = emptyMemoryPlacement(
      `GPU process pid ${pid}${suffix}`,
      "device",
    );
    placement.otherBytes = info.bytes;
    placement.totalBytes = info.bytes;
    entries.push(placement);
  }

  for (const usage of sample.processMemory) {
    if (usage.anonBytes > 0) {
      const placement = emptyMemoryPlacement(
        `Process RAM pid ${usage.pid} (anon)`,
        "host",
      );
      placement.otherBytes = usage.anonBytes;
      placement.totalBytes = usage.anonBytes;
      entries.push(placement);
    }
    if (usage.fileBytes > 0) {
      const placement = emptyMemoryPlacement(
        `Process RAM pid ${usage.pid} (mmap file)`,
        "other",
      );
      placement.otherBytes = usage.fileBytes;
      placement.totalBytes = usage.fileBytes;
      entries.push(placement);
    }
  }

  if (entries.length === 0) {
    return null;
  }

  const contributingPids = [
    ...new Set(
      entries
        .map((entry) => /\bpid\s+(\d+)\b/i.exec(entry.label)?.[1])
        .map((pid) => (pid ? Number(pid) : null))
        .filter((pid): pid is number => pid !== null),
    ),
  ].sort((left, right) => left - right);

  return layoutFromEntries({
    entries,
    baseLayout: input.baseLayout,
    processIds: contributingPids,
  });
}
