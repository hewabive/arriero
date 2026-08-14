import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeLaunchSnapshot } from "./launch-snapshot.js";
import { reconcileProcessRuns } from "./reconcile.js";
import { createProcessRun, latestProcessRun } from "./runs-repository.js";
import { supervisor } from "./supervisor.js";

function makeInstance(name: string, binaryPath: string): Instance {
  return {
    name,
    binaryPath,
    status: "stopped",
    pid: null,
    args: {},
    env: {},
  } as Instance;
}

function seedOpenRun(input: {
  instanceId: string;
  pid: number;
  snapshotBinaryPath: string | null;
}) {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  const logPath = join(dir, "instance.log");
  const rawLogPath = join(dir, "instance.raw.log");
  writeFileSync(logPath, "");
  writeFileSync(rawLogPath, "# raw\n");
  return createProcessRun({
    instanceId: input.instanceId,
    pid: input.pid,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath,
    rawLogPath,
    launchSnapshot: input.snapshotBinaryPath
      ? serializeLaunchSnapshot({
          binaryPath: input.snapshotBinaryPath,
          cliArgs: ["60"],
          env: {},
          cwd: "/bin",
          numa: null,
          rpcWorkers: [],
        })
      : null,
  });
}

async function spawnSleep() {
  const child = spawn("/bin/sleep", ["60"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return child.pid!;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("reconcile adopts a live process whose cmdline matches the launch snapshot", async () => {
  const pid = await spawnSleep();
  try {
    seedOpenRun({
      instanceId: "adopt-me",
      pid,
      snapshotBinaryPath: "/bin/sleep",
    });

    const summary = reconcileProcessRuns([
      makeInstance("adopt-me", "/bin/sleep"),
    ]);

    assert.equal(summary.adopted, 1);
    const state = supervisor.getState("adopt-me");
    assert.equal(state?.status, "running");
    assert.equal(state?.adopted, true);
    assert.equal(state?.pid, pid);
    assert.equal(latestProcessRun("adopt-me")?.status, "running");
    assert.equal(latestProcessRun("adopt-me")?.adopted, "true");

    supervisor.stop("adopt-me", "operator");
    assert.ok(
      await waitFor(() => latestProcessRun("adopt-me")?.status === "exited"),
      "adopted process should be stopped and finalized",
    );
    assert.equal(supervisor.getState("adopt-me")?.status, "exited");
    assert.equal(latestProcessRun("adopt-me")?.stopReason, "operator");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile marks a live process with mismatched cmdline as stale", async () => {
  const pid = await spawnSleep();
  try {
    seedOpenRun({
      instanceId: "mismatch",
      pid,
      snapshotBinaryPath: "/opt/llama/llama-server",
    });

    const summary = reconcileProcessRuns([
      makeInstance("mismatch", "/opt/llama/llama-server"),
    ]);

    assert.equal(summary.adopted, 0);
    assert.equal(summary.stale, 1);
    assert.equal(latestProcessRun("mismatch")?.status, "stale");
    assert.equal(supervisor.getState("mismatch"), undefined);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile leaves a matching run of a quarantined instance open", async () => {
  const pid = await spawnSleep();
  try {
    seedOpenRun({
      instanceId: "quarantined-open",
      pid,
      snapshotBinaryPath: "/bin/sleep",
    });

    const summary = reconcileProcessRuns([], new Set(["quarantined-open"]));

    assert.equal(summary.deferred, 1);
    assert.equal(latestProcessRun("quarantined-open")?.status, "running");
    assert.equal(supervisor.getState("quarantined-open"), undefined);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile still marks a quarantined run stale on cmdline mismatch", async () => {
  const pid = await spawnSleep();
  try {
    seedOpenRun({
      instanceId: "quarantined-mismatch",
      pid,
      snapshotBinaryPath: "/opt/llama/llama-server",
    });

    const summary = reconcileProcessRuns([], new Set(["quarantined-mismatch"]));

    assert.equal(summary.deferred, 0);
    assert.equal(latestProcessRun("quarantined-mismatch")?.status, "stale");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile closes runs whose pid is gone", async () => {
  const child = spawn("/bin/sleep", ["0"]);
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));

  seedOpenRun({ instanceId: "dead", pid, snapshotBinaryPath: "/bin/sleep" });

  const summary = reconcileProcessRuns([makeInstance("dead", "/bin/sleep")]);

  assert.ok(summary.exited >= 1);
  assert.equal(latestProcessRun("dead")?.status, "exited");
  assert.equal(latestProcessRun("dead")?.stopReason, "crash");
});

test("reconcile adopts a KTransformers bin/sglang root process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-kt-"));
  const binary = join(dir, "sglang");
  writeFileSync(binary, "#!/bin/sh\nwhile :; do sleep 1; done\n", {
    mode: 0o755,
  });
  const child = spawn(binary, ["serve"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  const pid = child.pid!;
  const name = `adopt-kt-${pid}`;
  try {
    seedOpenRun({
      instanceId: name,
      pid,
      snapshotBinaryPath: binary,
    });
    const instance = {
      ...makeInstance(name, binary),
      kind: "ktransformers" as const,
      binaryPathRefId: "kt-bin",
      memory: [],
      rpcWorkers: [],
      engineConfig: {
        type: "ktransformers" as const,
        model: "owner/model",
        cpuWeights: dir,
        method: "FP8" as const,
      },
      scheduling: { evictionPolicy: "idle-only" as const },
    };

    const summary = reconcileProcessRuns([instance]);
    assert.equal(summary.adopted, 1);
    assert.equal(supervisor.getState(name)?.adopted, true);

    supervisor.stop(name, "operator", 1_000);
    assert.ok(
      await waitFor(() => latestProcessRun(name)?.status === "exited"),
      "adopted KTransformers process should stop",
    );
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      void 0;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
