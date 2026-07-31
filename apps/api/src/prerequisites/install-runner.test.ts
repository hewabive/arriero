import assert from "node:assert/strict";
import { test } from "node:test";

import { detectInstallCapability } from "./install-capability.js";
import {
  PrerequisiteInstallRunner,
  executedInstallCommand,
} from "./install-runner.js";

test("strips the sudo prefix only when running as root", () => {
  assert.equal(
    executedInstallCommand("sudo apt install -y cmake", "root"),
    "apt install -y cmake",
  );
  assert.equal(
    executedInstallCommand("sudo apt install -y cmake", "passwordless-sudo"),
    "sudo apt install -y cmake",
  );
});

test("runs a command to completion and captures the log", async () => {
  const runner = new PrerequisiteInstallRunner();
  const started = runner.start(
    { scope: "required" },
    "printf 'line-out'; exit 0",
    null,
  );
  assert.equal(started.status, "running");
  await runner.waitForCompletion();
  const run = runner.latest();
  assert.ok(run);
  assert.equal(run.status, "succeeded");
  assert.equal(run.exitCode, 0);
  assert.equal(run.finishedAt !== null, true);
  assert.match(run.log, /line-out/);
});

test("reports a failing command with its exit code", async () => {
  const runner = new PrerequisiteInstallRunner();
  runner.start({ scope: "all" }, "printf 'boom' >&2; exit 7", null);
  await runner.waitForCompletion();
  const run = runner.latest();
  assert.ok(run);
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 7);
  assert.match(run.log, /boom/);
});

test("refuses to start a second run while one is active", async () => {
  const runner = new PrerequisiteInstallRunner();
  runner.start({ scope: "required" }, "sleep 0.3", null);
  assert.throws(
    () => runner.start({ scope: "required" }, "true", null),
    /already running/,
  );
  const running = runner.latest();
  assert.ok(running);
  assert.equal(running.status, "running");
  await runner.waitForCompletion();
});

test("capability is available for root without probing sudo", async () => {
  const capability = await detectInstallCapability(async () => {
    throw new Error("probe must not run for root");
  }, 0);
  assert.deepEqual(capability, {
    available: true,
    method: "root",
    reason: null,
  });
});

test("capability follows the sudo probe outcome for ordinary users", async () => {
  const allowed = await detectInstallCapability(
    async () => ({ code: 0, stderr: "", spawnError: null }),
    1000,
  );
  assert.equal(allowed.available, true);
  assert.equal(allowed.method, "passwordless-sudo");

  const denied = await detectInstallCapability(
    async () => ({
      code: 1,
      stderr: "sudo: a password is required",
      spawnError: null,
    }),
    1000,
  );
  assert.equal(denied.available, false);
  assert.equal(denied.method, null);
  assert.match(denied.reason ?? "", /password/);

  const noSudo = await detectInstallCapability(
    async () => ({ code: null, stderr: "", spawnError: "spawn sudo ENOENT" }),
    1000,
  );
  assert.equal(noSudo.available, false);
  assert.match(noSudo.reason ?? "", /sudo is not available/);
});
