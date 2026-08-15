import {
  BenchmarkScenarioSchema,
  type BenchmarkRunResult,
} from "@arriero/core";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { newId } from "../utils/id.js";
import {
  benchmarkArtifactsRoot,
  createBenchmarkRun,
  deleteBenchmarkRun,
  failInterruptedBenchmarkRuns,
  getBenchmarkRun,
  listBenchmarkRuns,
  patchBenchmarkRun,
  readBenchmarkRunResult,
  writeBenchmarkRunArtifacts,
} from "./repository.js";

function scenario() {
  return BenchmarkScenarioSchema.parse({
    target: { kind: "instance", instanceName: "bench-target" },
    mode: "parallel",
    composition: [{ promptId: "code-en-task-queue", count: 2 }],
  });
}

function emptyResult(): BenchmarkRunResult {
  return { requests: [], segments: [], segmentClasses: [], topics: [] };
}

test("benchmark run lifecycle roundtrip", () => {
  const id = newId();
  const created = createBenchmarkRun({ id, scenario: scenario() });
  assert.equal(created.status, "running");

  const loaded = getBenchmarkRun(id);
  assert.equal(loaded?.status, "running");
  assert.equal(loaded?.scenario.target.instanceName, "bench-target");
  assert.equal(loaded?.scenario.repetitions, 1);
  assert.equal(loaded?.scenario.cacheBust, true);

  patchBenchmarkRun(id, {
    status: "succeeded",
    finishedAt: new Date().toISOString(),
    warnings: ["slots unknown"],
    summary: {
      requestCount: 2,
      failedRequestCount: 0,
      totalCompletionTokens: 100,
      wallMs: 2000,
      acceptanceRate: null,
      headline: null,
      topics: [],
      segmentClasses: [],
    },
  });
  const patched = getBenchmarkRun(id);
  assert.equal(patched?.status, "succeeded");
  assert.deepEqual(patched?.warnings, ["slots unknown"]);
  assert.equal(patched?.summary?.requestCount, 2);

  assert.ok(listBenchmarkRuns(10).some((run) => run.id === id));
  assert.equal(deleteBenchmarkRun(id), true);
  assert.equal(getBenchmarkRun(id), null);
  assert.equal(deleteBenchmarkRun(id), false);
});

test("artifacts roundtrip and cleanup on delete", () => {
  const id = newId();
  createBenchmarkRun({ id, scenario: scenario() });
  writeBenchmarkRunArtifacts(
    id,
    [{ requestId: "r1", tMs: 5, kind: "submit" }],
    emptyResult(),
  );
  assert.deepEqual(readBenchmarkRunResult(id), emptyResult());
  const dir = resolve(benchmarkArtifactsRoot, id);
  assert.ok(existsSync(dir));
  assert.equal(deleteBenchmarkRun(id), true);
  assert.equal(existsSync(dir), false);
  assert.equal(readBenchmarkRunResult(id), null);
});

test("interrupted running runs are failed at boot", () => {
  const id = newId();
  createBenchmarkRun({ id, scenario: scenario() });
  assert.ok(failInterruptedBenchmarkRuns() >= 1);
  const run = getBenchmarkRun(id);
  assert.equal(run?.status, "failed");
  assert.equal(run?.error, "interrupted by manager restart");
  deleteBenchmarkRun(id);
});
