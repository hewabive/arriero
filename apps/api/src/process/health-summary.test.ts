import type { Instance, RuntimeState } from "@llama-manager/core";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { deriveStatus, getInstanceHealthSummary } from "./health-summary.js";

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
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
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
