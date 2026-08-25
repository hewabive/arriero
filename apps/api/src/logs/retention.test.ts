import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { db } from "../db/index.js";
import { processRuns, webappRuns } from "../db/schema.js";
import { saveLogRetentionSettings } from "../settings/logs.js";
import { webappLogsDir } from "../webapps/paths.js";
import { getLogUsage, pruneManagedLogs } from "./retention.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;

function msBefore(days: number): number {
  return NOW.getTime() - days * 24 * HOUR_MS;
}

function writeLog(dir: string, name: string, bytes = 10): string {
  const path = resolve(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 97));
  return path;
}

function seedProcessRun(input: {
  id: string;
  instanceId: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  logPath: string;
}) {
  db.insert(processRuns)
    .values({
      id: input.id,
      instanceId: input.instanceId,
      pid: null,
      status: input.status,
      startedAt: input.startedAt,
      stoppedAt: input.stoppedAt,
      exitCode: null,
      logPath: input.logPath,
      rawLogPath: null,
    })
    .run();
}

function seedWebappRun(input: {
  id: string;
  webappId: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  logPath: string;
}) {
  db.insert(webappRuns)
    .values({
      id: input.id,
      webappId: input.webappId,
      pid: null,
      status: input.status,
      startedAt: input.startedAt,
      stoppedAt: input.stoppedAt,
      exitCode: null,
      logPath: input.logPath,
      rawLogPath: null,
    })
    .run();
}

beforeEach(() => {
  rmSync(config.logsDir, { recursive: true, force: true });
  mkdirSync(webappLogsDir(), { recursive: true });
  db.delete(processRuns).run();
  db.delete(webappRuns).run();
});

test("age prune deletes expired files but keeps protected, recent and unclassified ones", () => {
  saveLogRetentionSettings({ retentionDays: 30, maxTotalMb: null });
  const old = msBefore(40);
  const mid = msBefore(10);

  const aOld = writeLog(config.logsDir, `alpha-${old}.log`);
  const aOldRaw = writeLog(config.logsDir, `alpha-${old}.raw.log`);
  const aMid = writeLog(config.logsDir, `alpha-${mid}.log`);
  const bLatest = writeLog(config.logsDir, `beta-${old}.log`);
  const cOpen = writeLog(config.logsDir, `gamma-${old}.log`);
  const buildOld = writeLog(config.logsDir, `build-${old}.log`);
  const envOld = writeLog(config.logsDir, `env-0123456789ab-${old}.log`);
  const stray = writeLog(config.logsDir, "notes.txt");
  const wOld = writeLog(webappLogsDir(), `chat-${old}.log`);
  const wOpen = writeLog(webappLogsDir(), `chatp-${old}.log`);

  seedProcessRun({
    id: "b1",
    instanceId: "beta",
    status: "exited",
    startedAt: new Date(old).toISOString(),
    stoppedAt: new Date(old + HOUR_MS).toISOString(),
    logPath: bLatest,
  });
  seedProcessRun({
    id: "c1",
    instanceId: "gamma",
    status: "running",
    startedAt: new Date(old).toISOString(),
    stoppedAt: null,
    logPath: cOpen,
  });
  seedWebappRun({
    id: "w1",
    webappId: "chatp",
    status: "running",
    startedAt: new Date(old).toISOString(),
    stoppedAt: null,
    logPath: wOpen,
  });

  const result = pruneManagedLogs(NOW);

  assert.equal(result.deletedFiles, 5);
  assert.equal(result.freedBytes, 50);
  for (const path of [aOld, aOldRaw, buildOld, envOld, wOld]) {
    assert.equal(existsSync(path), false, path);
  }
  for (const path of [aMid, bLatest, cOpen, stray, wOpen]) {
    assert.equal(existsSync(path), true, path);
  }
});

test("size cap deletes the oldest deletable files until under the cap", () => {
  saveLogRetentionSettings({ retentionDays: 3650, maxTotalMb: 16 });
  const d10 = writeLog(config.logsDir, `delta-${msBefore(10)}.log`, 10 * MB);
  const d5 = writeLog(config.logsDir, `delta-${msBefore(5)}.log`, 5 * MB);
  const d2 = writeLog(config.logsDir, `delta-${msBefore(2)}.log`, 4 * MB);

  const result = pruneManagedLogs(NOW);

  assert.equal(result.deletedFiles, 1);
  assert.equal(result.freedBytes, 10 * MB);
  assert.equal(existsSync(d10), false);
  assert.equal(existsSync(d5), true);
  assert.equal(existsSync(d2), true);
});

test("size cap skips protected files and moves to the next oldest", () => {
  saveLogRetentionSettings({ retentionDays: 3650, maxTotalMb: 16 });
  const e10 = writeLog(config.logsDir, `eps-${msBefore(10)}.log`, 10 * MB);
  const e5 = writeLog(config.logsDir, `eps-${msBefore(5)}.log`, 5 * MB);
  const e2 = writeLog(config.logsDir, `eps-${msBefore(2)}.log`, 4 * MB);
  seedProcessRun({
    id: "e1",
    instanceId: "eps",
    status: "running",
    startedAt: new Date(msBefore(10)).toISOString(),
    stoppedAt: null,
    logPath: e10,
  });

  const result = pruneManagedLogs(NOW);

  assert.equal(result.deletedFiles, 1);
  assert.equal(existsSync(e10), true);
  assert.equal(existsSync(e5), false);
  assert.equal(existsSync(e2), true);
});

test("files younger than a day are never deleted, even over the cap", () => {
  saveLogRetentionSettings({ retentionDays: 1, maxTotalMb: 16 });
  const young = writeLog(
    config.logsDir,
    `zeta-${NOW.getTime() - 2 * HOUR_MS}.log`,
    20 * MB,
  );

  const result = pruneManagedLogs(NOW);

  assert.equal(result.deletedFiles, 0);
  assert.equal(existsSync(young), true);
});

test("usage aggregates files per category with the oldest timestamp", () => {
  const old = msBefore(12);
  writeLog(config.logsDir, `alpha-${old}.log`, 100);
  writeLog(config.logsDir, `alpha-${msBefore(3)}.raw.log`, 40);
  writeLog(config.logsDir, `build-${msBefore(5)}.log`, 30);
  writeLog(config.logsDir, "notes.txt", 7);
  writeLog(webappLogsDir(), `chat-${msBefore(4)}.log`, 20);

  const usage = getLogUsage();

  assert.equal(usage.totalFiles, 5);
  assert.equal(usage.totalBytes, 197);
  assert.equal(usage.oldestFileAt, new Date(old).toISOString());
  const byCategory = new Map(
    usage.categories.map((entry) => [entry.category, entry]),
  );
  assert.deepEqual(byCategory.get("instance"), {
    category: "instance",
    files: 2,
    bytes: 140,
  });
  assert.deepEqual(byCategory.get("build"), {
    category: "build",
    files: 1,
    bytes: 30,
  });
  assert.deepEqual(byCategory.get("webapp"), {
    category: "webapp",
    files: 1,
    bytes: 20,
  });
  assert.deepEqual(byCategory.get("other"), {
    category: "other",
    files: 1,
    bytes: 7,
  });
});
