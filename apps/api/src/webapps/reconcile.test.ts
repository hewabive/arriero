import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { resetWebappsCache } from "./config-files.js";
import { serializeWebappLaunchSnapshot } from "./launch.js";
import { reconcileWebappRuns } from "./reconcile.js";
import { createWebapp } from "./repository.js";
import { createWebappRun, latestWebappRun } from "./runs-repository.js";
import { webappSupervisor } from "./supervisor.js";

beforeEach(() => {
  resetWebappsCache();
});

function makeRecord(name: string) {
  createWebapp(
    {
      name,
      kind: "open-webui",
      envSpecId: "env-spec-1",
      autostart: false,
      createProxySource: false,
    },
    null,
  );
}

function seedOpenRun(input: {
  name: string;
  pid: number;
  snapshotBinaryPath: string | null;
}) {
  const dir = mkdtempSync(join(tmpdir(), "webapp-reconcile-test-"));
  const logPath = join(dir, "webapp.log");
  const rawLogPath = join(dir, "webapp.raw.log");
  writeFileSync(logPath, "");
  writeFileSync(rawLogPath, "# raw\n");
  return createWebappRun({
    webappId: input.name,
    pid: input.pid,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath,
    rawLogPath,
    launchSnapshot: input.snapshotBinaryPath
      ? serializeWebappLaunchSnapshot({
          binaryPath: input.snapshotBinaryPath,
          cliArgs: ["60"],
          cwd: "/tmp",
          envSpecId: "env-spec-1",
          renderHash: "test-hash",
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

test("reconcile adopts a live webapp whose cmdline matches the launch snapshot", async () => {
  const pid = await spawnSleep();
  try {
    makeRecord("adopt-webapp");
    seedOpenRun({
      name: "adopt-webapp",
      pid,
      snapshotBinaryPath: "/bin/sleep",
    });

    const summary = reconcileWebappRuns();

    assert.equal(summary.adopted, 1);
    const state = webappSupervisor.getState("adopt-webapp");
    assert.equal(state?.status, "running");
    assert.equal(state?.adopted, true);
    assert.equal(state?.pid, pid);
    assert.equal(latestWebappRun("adopt-webapp")?.status, "running");
    assert.equal(latestWebappRun("adopt-webapp")?.adopted, "true");

    webappSupervisor.stop("adopt-webapp", "operator");
    assert.ok(
      await waitFor(() => latestWebappRun("adopt-webapp")?.status === "exited"),
      "adopted webapp should be stopped and finalized",
    );
    assert.equal(webappSupervisor.getState("adopt-webapp")?.status, "exited");
    assert.equal(latestWebappRun("adopt-webapp")?.stopReason, "operator");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile marks a live webapp run with mismatched cmdline as stale", async () => {
  const pid = await spawnSleep();
  try {
    makeRecord("mismatch-webapp");
    seedOpenRun({
      name: "mismatch-webapp",
      pid,
      snapshotBinaryPath: "/opt/envs/open-webui/bin/open-webui",
    });

    const summary = reconcileWebappRuns();

    assert.equal(summary.adopted, 0);
    assert.equal(summary.stale, 1);
    assert.equal(latestWebappRun("mismatch-webapp")?.status, "stale");
    assert.equal(webappSupervisor.getState("mismatch-webapp"), undefined);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile leaves a matching run of a quarantined webapp open", async () => {
  const pid = await spawnSleep();
  try {
    seedOpenRun({
      name: "quarantined-webapp",
      pid,
      snapshotBinaryPath: "/bin/sleep",
    });

    const summary = reconcileWebappRuns(new Set(["quarantined-webapp"]));

    assert.equal(summary.deferred, 1);
    assert.equal(latestWebappRun("quarantined-webapp")?.status, "running");
    assert.equal(webappSupervisor.getState("quarantined-webapp"), undefined);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
});

test("reconcile closes webapp runs whose pid is gone", async () => {
  const child = spawn("/bin/sleep", ["0"]);
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));

  seedOpenRun({ name: "dead-webapp", pid, snapshotBinaryPath: "/bin/sleep" });

  const summary = reconcileWebappRuns();

  assert.ok(summary.exited >= 1);
  assert.equal(latestWebappRun("dead-webapp")?.status, "exited");
  assert.equal(latestWebappRun("dead-webapp")?.stopReason, "crash");
});
