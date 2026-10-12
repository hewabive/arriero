import type { Instance, RuntimeState } from "@arriero/core";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { deriveStatus, getInstanceHealthSummary } from "./health-summary.js";
import {
  buildLaunchSnapshot,
  serializeLaunchSnapshot,
} from "./launch-snapshot.js";
import {
  createProcessRun,
  deleteProcessRunsForInstance,
} from "./runs-repository.js";

function instance(input: Partial<Instance>): Instance {
  return {
    name: input.name ?? "test-instance",
    kind: input.kind ?? "llama-server",
    rpcWorkers: input.rpcWorkers ?? [],
    binaryPath: input.binaryPath ?? "/bin/sh",
    binaryPathRefId: input.binaryPathRefId ?? "test-binary",
    cwd: input.cwd ?? tmpdir(),
    args: input.args ?? {},
    env: {},
    memory: input.memory ?? [],
    status: input.status ?? "stopped",
    pid: input.pid ?? null,
  };
}

function runningRuntime(): RuntimeState {
  return {
    instanceId: "w1",
    pid: 1234,
    status: "running",
    startedAt: "2026-06-25T00:00:00.000Z",
    stoppedAt: null,
    exitCode: null,
    logPath: null,
    rawLogPath: null,
  };
}

function baseInput() {
  return {
    runtime: runningRuntime(),
    engine: { httpHealth: false, displayName: "rpc-server" },
    preflightOk: true,
    preflightErrors: 0,
    preflightWarnings: 0,
    healthOk: false,
    healthStatus: null,
    logReady: false,
    logErrors: 0,
    logWarnings: 0,
    swapBytes: 0,
    numaPlacement: null,
  };
}

test("running rpc-worker is ready even when the tcp probe fails", () => {
  const derived = deriveStatus(baseInput());
  assert.equal(derived.status, "ready");
  assert.match(derived.reason, /not answered/);
});

test("running rpc-worker reachable on its port reports listening", () => {
  const derived = deriveStatus({ ...baseInput(), healthOk: true });
  assert.equal(derived.status, "ready");
  assert.match(derived.reason, /listening/);
});

test("running rpc-worker with swapped-out memory is degraded", () => {
  const derived = deriveStatus({
    ...baseInput(),
    swapBytes: 128 * 1024 * 1024,
  });
  assert.equal(derived.status, "degraded");
  assert.match(derived.reason, /swap/);
});

test("running llama-server with a failing health endpoint still loads", () => {
  const derived = deriveStatus({
    ...baseInput(),
    engine: { httpHealth: true, displayName: "llama-server" },
  });
  assert.equal(derived.status, "loading");
});

test("KTransformers readiness text is engine-aware while HTTP remains authoritative", () => {
  const derived = deriveStatus({
    ...baseInput(),
    runtime: { ...runningRuntime(), status: "starting" },
    engine: {
      httpHealth: true,
      displayName: "KTransformers (SGLang-KT)",
    },
    logReady: true,
  });
  assert.equal(derived.status, "starting");
  assert.match(derived.reason, /KTransformers/);
});

test("SGLang readiness text uses the engine display name", () => {
  const derived = deriveStatus({
    ...baseInput(),
    runtime: { ...runningRuntime(), status: "starting" },
    engine: { httpHealth: true, displayName: "SGLang" },
    logReady: true,
  });
  assert.equal(derived.status, "starting");
  assert.match(derived.reason, /SGLang readiness/);
});

test("error-state runtime surfaces the recent log error tail in the reason", () => {
  const derived = deriveStatus({
    ...baseInput(),
    runtime: { ...runningRuntime(), status: "error", exitCode: 0 },
    logErrors: 1,
    logErrorTail: ["error: unknown argument: --model"],
  });
  assert.equal(derived.status, "error");
  assert.match(derived.reason, /error: unknown argument: --model/);
});

test("error-state runtime with no log errors falls back to a generic reason", () => {
  const derived = deriveStatus({
    ...baseInput(),
    runtime: { ...runningRuntime(), status: "error", exitCode: 0 },
  });
  assert.equal(derived.status, "error");
  assert.match(derived.reason, /error state/);
});

test("scheduling-mode health summary skips the start-time rpc-worker readiness probe", async () => {
  const stopped = instance({
    name: "orchestrator-under-test",
    status: "stopped",
    args: { "--host": "127.0.0.1", "--port": 47591 },
    rpcWorkers: [{ nodeId: null, instanceName: "missing-worker" }],
  });

  const hasRpcIssue = (
    health: Awaited<ReturnType<typeof getInstanceHealthSummary>>,
  ) => health.preflight.issues.some((issue) => issue.field === "rpcWorkers");

  const diagnostics = await getInstanceHealthSummary(stopped, {});
  const scheduling = await getInstanceHealthSummary(stopped, {
    checkStartAvailability: false,
  });

  assert.equal(hasRpcIssue(diagnostics), true);
  assert.equal(hasRpcIssue(scheduling), false);
});

test("health summary exposes the configured concurrency limit for each engine", async () => {
  const cases: Array<{
    kind: Instance["kind"];
    args: Instance["args"];
    expected: number | null;
  }> = [
    { kind: "llama-server", args: { "-np": 4 }, expected: 4 },
    {
      kind: "vllm",
      args: { "--max-num-seqs": 64, "--max-num-active-seqs": "16" },
      expected: 16,
    },
    { kind: "sglang", args: { "--max-running-requests": "8" }, expected: 8 },
    {
      kind: "ktransformers",
      args: { "--max-running-requests": 2 },
      expected: 2,
    },
    { kind: "rpc-worker", args: {}, expected: null },
    { kind: "vllm", args: {}, expected: null },
    { kind: "sglang", args: { "--max-running-requests": 0 }, expected: null },
    {
      kind: "llama-server",
      args: { "--models-preset": "/tmp/models.ini", "--parallel": 8 },
      expected: null,
    },
  ];
  for (const { kind, args, expected } of cases) {
    const summary = await getInstanceHealthSummary(instance({ kind, args }), {
      checkStartAvailability: false,
    });
    assert.equal(
      summary.configuredLimit,
      expected,
      `${kind}: ${JSON.stringify(args)}`,
    );
  }
});

test("health summary withholds the configured limit when the launch config has drifted", async (t) => {
  const original = instance({
    name: "configured-limit-drift",
    kind: "vllm",
    status: "stopping",
    args: { "--max-num-seqs": 4 },
  });
  createProcessRun({
    instanceId: original.name,
    pid: null,
    status: "stopping",
    startedAt: new Date().toISOString(),
    logPath: "",
    rawLogPath: null,
    launchSnapshot: serializeLaunchSnapshot(buildLaunchSnapshot(original)),
  });
  t.after(() => deleteProcessRunsForInstance(original.name));
  const summary = await getInstanceHealthSummary({
    ...original,
    args: { "--max-num-seqs": 8 },
  });
  assert.equal(summary.configDrift, true);
  assert.equal(summary.configuredLimit, null);
});
