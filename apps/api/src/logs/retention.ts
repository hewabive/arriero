import type { LogFileCategory, LogStorageUsage } from "@arriero/core";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { startRetentionLoop } from "../db/retention.js";
import { listProtectedProcessRunLogPaths } from "../process/runs-repository.js";
import { getLogRetentionSettings } from "../settings/logs.js";
import { traceBlockingSection } from "../system/event-loop.js";
import { webappLogsDir } from "../webapps/paths.js";
import { listProtectedWebappRunLogPaths } from "../webapps/runs-repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_FILE_AGE_MS = DAY_MS;
const MB = 1024 * 1024;

type ManagedLogFile = {
  path: string;
  category: LogFileCategory;
  timestampMs: number | null;
  bytes: number;
};

type DatedLogFile = ManagedLogFile & { timestampMs: number };

const JOB_LOG_PATTERNS: Array<{
  category: LogFileCategory;
  pattern: RegExp;
}> = [
  { category: "build", pattern: /^build-(\d{13})\.log$/ },
  { category: "update", pattern: /^update-(\d{13})\.log$/ },
  { category: "env", pattern: /^env-.+-(\d{13})\.log$/ },
];

const RUN_LOG_PATTERN = /^.+-(\d{13})\.(?:raw\.)?log$/;

function classifyLogFile(
  name: string,
  runCategory: LogFileCategory,
  withJobLogs: boolean,
): { category: LogFileCategory; timestampMs: number | null } {
  if (withJobLogs) {
    for (const { category, pattern } of JOB_LOG_PATTERNS) {
      const match = pattern.exec(name);
      if (match?.[1]) {
        return { category, timestampMs: Number(match[1]) };
      }
    }
  }
  const match = RUN_LOG_PATTERN.exec(name);
  if (match?.[1]) {
    return { category: runCategory, timestampMs: Number(match[1]) };
  }
  return { category: "other", timestampMs: null };
}

function statSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function scanDir(
  dir: string,
  runCategory: LogFileCategory,
  withJobLogs: boolean,
): ManagedLogFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: ManagedLogFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = resolve(dir, entry.name);
    const bytes = statSizeOrNull(path);
    if (bytes === null) {
      continue;
    }
    files.push({
      path,
      bytes,
      ...classifyLogFile(entry.name, runCategory, withJobLogs),
    });
  }
  return files;
}

function scanManagedLogFiles(): ManagedLogFile[] {
  return [
    ...scanDir(config.logsDir, "instance", true),
    ...scanDir(webappLogsDir(), "webapp", false),
  ];
}

export function getLogUsage(): Omit<LogStorageUsage, "proxyRequests"> {
  const files = scanManagedLogFiles();
  const byCategory = new Map<
    LogFileCategory,
    { files: number; bytes: number }
  >();
  let totalBytes = 0;
  let oldestMs: number | null = null;
  for (const file of files) {
    totalBytes += file.bytes;
    const bucket = byCategory.get(file.category) ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += file.bytes;
    byCategory.set(file.category, bucket);
    if (
      file.timestampMs !== null &&
      (oldestMs === null || file.timestampMs < oldestMs)
    ) {
      oldestMs = file.timestampMs;
    }
  }
  return {
    totalFiles: files.length,
    totalBytes,
    oldestFileAt: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    categories: [...byCategory.entries()].map(([category, bucket]) => ({
      category,
      ...bucket,
    })),
  };
}

export function pruneManagedLogs(now = new Date()): {
  deletedFiles: number;
  freedBytes: number;
} {
  const settings = getLogRetentionSettings();
  const files = scanManagedLogFiles();
  const protectedPaths = new Set([
    ...listProtectedProcessRunLogPaths(),
    ...listProtectedWebappRunLogPaths(),
  ]);
  const minAgeCutoffMs = now.getTime() - MIN_FILE_AGE_MS;
  const ageCutoffMs = now.getTime() - settings.retentionDays * DAY_MS;

  const deletable: DatedLogFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes;
    if (
      file.timestampMs === null ||
      file.timestampMs >= minAgeCutoffMs ||
      protectedPaths.has(file.path)
    ) {
      continue;
    }
    deletable.push({ ...file, timestampMs: file.timestampMs });
  }

  const toDelete = new Map<string, DatedLogFile>();
  for (const file of deletable) {
    if (file.timestampMs < ageCutoffMs) {
      toDelete.set(file.path, file);
    }
  }

  if (settings.maxTotalMb !== null) {
    const capBytes = settings.maxTotalMb * MB;
    let remainingBytes = totalBytes;
    for (const file of toDelete.values()) {
      remainingBytes -= file.bytes;
    }
    const candidates = deletable
      .filter((file) => !toDelete.has(file.path))
      .sort((a, b) => a.timestampMs - b.timestampMs);
    for (const file of candidates) {
      if (remainingBytes <= capBytes) {
        break;
      }
      toDelete.set(file.path, file);
      remainingBytes -= file.bytes;
    }
  }

  let freedBytes = 0;
  traceBlockingSection("logs:retention-prune", () => {
    for (const file of toDelete.values()) {
      rmSync(file.path, { force: true });
      freedBytes += file.bytes;
    }
  });
  return { deletedFiles: toDelete.size, freedBytes };
}

export function startLogRetentionLoop(options: {
  onError?: (error: unknown) => void;
}): () => void {
  return startRetentionLoop(() => pruneManagedLogs(), options);
}
