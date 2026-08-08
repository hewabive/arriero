import assert from "node:assert/strict";
import { test } from "node:test";

import { db } from "../db/index.js";
import { processRuns } from "../db/schema.js";
import {
  createProcessRun,
  latestProcessRun,
  pruneProcessRunHistory,
  updateProcessRun,
} from "./runs-repository.js";

function seedRun(input: {
  id: string;
  instanceId: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
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
      logPath: "/tmp/x.log",
      rawLogPath: null,
    })
    .run();
}

function seedClosedRuns(instanceId: string, count: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `${instanceId}-${String(index).padStart(2, "0")}`;
    const second = String(index).padStart(2, "0");
    seedRun({
      id,
      instanceId,
      status: "exited",
      startedAt: `2026-01-01T00:${second}:00.000Z`,
      stoppedAt: `2026-01-01T00:${second}:30.000Z`,
    });
    ids.push(id);
  }
  return ids;
}

function runIdsFor(instanceId: string): string[] {
  return db
    .select()
    .from(processRuns)
    .all()
    .filter((run) => run.instanceId === instanceId)
    .map((run) => run.id)
    .sort();
}

test("pruneProcessRunHistory keeps the last 20 closed runs plus open runs per instance", () => {
  const closed = seedClosedRuns("a", 23);
  seedRun({
    id: "a-stale",
    instanceId: "a",
    status: "stale",
    startedAt: "2026-01-01T00:00:10.000Z",
    stoppedAt: null,
  });
  seedRun({
    id: "b1",
    instanceId: "b",
    status: "running",
    startedAt: "2026-01-01T00:00:01.000Z",
    stoppedAt: null,
  });
  seedRun({
    id: "b2",
    instanceId: "b",
    status: "exited",
    startedAt: "2026-01-01T00:00:02.000Z",
    stoppedAt: "2026-01-01T00:00:03.000Z",
  });

  const result = pruneProcessRunHistory();

  assert.equal(result.deleted, 3);
  assert.deepEqual(runIdsFor("a"), ["a-stale", ...closed.slice(3)].sort());
  assert.deepEqual(runIdsFor("b"), ["b1", "b2"]);
});

test("createProcessRun keeps the last 20 closed runs and every open run for the instance", () => {
  seedClosedRuns("c", 20);
  seedRun({
    id: "c-stale",
    instanceId: "c",
    status: "stale",
    startedAt: "2026-01-01T00:00:05.500Z",
    stoppedAt: null,
  });

  const newId = createProcessRun({
    instanceId: "c",
    pid: 1234,
    status: "starting",
    startedAt: "2026-01-01T01:00:00.000Z",
    logPath: "/tmp/x.log",
    rawLogPath: null,
  });

  assert.equal(runIdsFor("c").length, 22);
  assert.ok(runIdsFor("c").includes("c-01"));
  assert.ok(runIdsFor("c").includes("c-stale"));
  assert.equal(latestProcessRun("c")?.id, newId);
});

test("the 21st closed run drops the oldest closed run on the next create", () => {
  seedClosedRuns("d", 20);

  const firstId = createProcessRun({
    instanceId: "d",
    pid: 100,
    status: "starting",
    startedAt: "2026-01-01T01:00:00.000Z",
    logPath: "/tmp/x.log",
    rawLogPath: null,
  });
  updateProcessRun(firstId, {
    pid: null,
    status: "exited",
    stoppedAt: "2026-01-01T01:00:30.000Z",
    exitCode: 0,
    stopReason: "operator",
  });
  assert.equal(latestProcessRun("d")?.stopReason, "operator");

  const secondId = createProcessRun({
    instanceId: "d",
    pid: 200,
    status: "starting",
    startedAt: "2026-01-01T02:00:00.000Z",
    logPath: "/tmp/x.log",
    rawLogPath: null,
  });

  const remaining = runIdsFor("d");
  assert.equal(remaining.includes("d-01"), false);
  assert.ok(remaining.includes("d-02"));
  assert.ok(remaining.includes(firstId));
  assert.ok(remaining.includes(secondId));
  assert.equal(remaining.length, 21);
});
