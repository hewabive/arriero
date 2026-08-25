import {
  LOG_FILE_CATEGORIES,
  type LogFileCategory,
  type LogStorageUsage,
} from "@arriero/core";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { config } from "../config.js";
import { startRetentionLoop } from "../db/retention.js";
import { runLogFileTimestampMs } from "../process/log-paths.js";
import { listProtectedProcessRunLogPaths } from "../process/runs-repository.js";
import { getLogRetentionSettings } from "../settings/logs.js";
import { statSizeOrNull } from "../utils/stat.js";
import { webappLogsDir } from "../webapps/paths.js";
import { listProtectedWebappRunLogPaths } from "../webapps/runs-repository.js";
import { JOB_LOG_PATTERNS } from "./log-names.js";

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
  const timestampMs = runLogFileTimestampMs(name);
  if (timestampMs !== null) {
    return { category: runCategory, timestampMs };
  }
  return { category: "other", timestampMs: null };
}

async function scanDir(
  dir: string,
  runCategory: LogFileCategory,
  withJobLogs: boolean,
): Promise<ManagedLogFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<ManagedLogFile | null> => {
        const path = resolve(dir, entry.name);
        const bytes = await statSizeOrNull(path);
        if (bytes === null) {
          return null;
        }
        return {
          path,
          bytes,
          ...classifyLogFile(entry.name, runCategory, withJobLogs),
        };
      }),
  );
  return files.filter((file): file is ManagedLogFile => file !== null);
}

async function scanManagedLogFiles(): Promise<ManagedLogFile[]> {
  const [managed, webapp] = await Promise.all([
    scanDir(config.logsDir, "instance", true),
    scanDir(webappLogsDir(), "webapp", false),
  ]);
  return [...managed, ...webapp];
}

export async function getLogUsage(): Promise<
  Omit<LogStorageUsage, "proxyRequests">
> {
  const files = await scanManagedLogFiles();
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
    categories: LOG_FILE_CATEGORIES.flatMap((category) => {
      const bucket = byCategory.get(category);
      return bucket ? [{ category, ...bucket }] : [];
    }),
  };
}

export async function pruneManagedLogs(now = new Date()): Promise<{
  deletedFiles: number;
  freedBytes: number;
}> {
  const settings = getLogRetentionSettings();
  const files = await scanManagedLogFiles();
  const protectedPaths = new Set([
    ...listProtectedProcessRunLogPaths(),
    ...listProtectedWebappRunLogPaths(),
  ]);
  const minAgeCutoffMs = now.getTime() - MIN_FILE_AGE_MS;
  const ageCutoffMs = now.getTime() - settings.retentionDays * DAY_MS;
  const capBytes =
    settings.maxTotalMb === null ? Infinity : settings.maxTotalMb * MB;

  const deletable: DatedLogFile[] = [];
  let remainingBytes = 0;
  for (const file of files) {
    remainingBytes += file.bytes;
    if (
      file.timestampMs === null ||
      file.timestampMs >= minAgeCutoffMs ||
      protectedPaths.has(file.path)
    ) {
      continue;
    }
    deletable.push({ ...file, timestampMs: file.timestampMs });
  }
  deletable.sort((a, b) => a.timestampMs - b.timestampMs);

  let deletedFiles = 0;
  let freedBytes = 0;
  for (const file of deletable) {
    if (file.timestampMs >= ageCutoffMs && remainingBytes <= capBytes) {
      break;
    }
    await rm(file.path, { force: true });
    deletedFiles += 1;
    freedBytes += file.bytes;
    remainingBytes -= file.bytes;
  }
  return { deletedFiles, freedBytes };
}

export function startLogRetentionLoop(options: {
  onError?: (error: unknown) => void;
}): () => void {
  return startRetentionLoop(() => pruneManagedLogs(), options);
}
