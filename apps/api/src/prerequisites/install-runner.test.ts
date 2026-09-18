import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";

import { shellQuote } from "../utils/shell.js";
import { detectInstallCapability } from "./install-capability.js";
import { InstallProcessTree } from "./install-process-tree.js";
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
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt install -y cmake",
  );
  assert.equal(
    executedInstallCommand(
      "sudo dnf config-manager --add-repo cuda.repo && sudo dnf clean expire-cache && sudo dnf install -y cuda-toolkit",
      "root",
    ),
    "dnf config-manager --add-repo cuda.repo && dnf clean expire-cache && dnf install -y cuda-toolkit",
  );
  assert.equal(
    executedInstallCommand(
      "sudo apt install -y pipx && pipx install uv",
      "root",
    ),
    "apt install -y pipx && pipx install uv",
  );
});

test("rewrites conditional sudo commands while preserving quoted mirror arguments", () => {
  const command =
    "(false || sudo dnf install -y pipx) && PIP_INDEX_URL='http://mirror/ && sudo untouched' pipx install uv && sudo dnf clean all";
  assert.equal(
    executedInstallCommand(command, "passwordless-sudo"),
    "(false || sudo -n env DEBIAN_FRONTEND=noninteractive dnf install -y pipx) && PIP_INDEX_URL='http://mirror/ && sudo untouched' pipx install uv && sudo -n env DEBIAN_FRONTEND=noninteractive dnf clean all",
  );
  assert.equal(
    executedInstallCommand(command, "root"),
    "(false || dnf install -y pipx) && PIP_INDEX_URL='http://mirror/ && sudo untouched' pipx install uv && dnf clean all",
  );
  assert.equal(executedInstallCommand(command, null), command);
  const mirrorCommand = `PIP_INDEX_URL=${shellQuote("http://mirror/it's && sudo untouched")} pipx install uv`;
  assert.equal(
    executedInstallCommand(mirrorCommand, "passwordless-sudo"),
    mirrorCommand,
  );
});

test("noninteractive environment survives sudo env_reset and pipx retains mirror settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "prerequisite-sudo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "sudo"),
    '#!/bin/sh\n[ "$1" = "-n" ] || exit 19\nshift\nexec env -u DEBIAN_FRONTEND "$@"\n',
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  const runner = new PrerequisiteInstallRunner();
  runner.start(
    { checkId: "uv" },
    `sudo sh -c 'test "$DEBIAN_FRONTEND" = noninteractive && echo apt-done' && PIP_INDEX_URL='http://mirror/simple' PIP_TRUSTED_HOST='mirror' sh -c 'echo pipx:$PIP_INDEX_URL:$PIP_TRUSTED_HOST:$DEBIAN_FRONTEND'`,
    "passwordless-sudo",
  );
  await runner.waitForCompletion();
  assert.equal(runner.latest()?.status, "succeeded");
  assert.match(
    runner.latest()?.log ?? "",
    /apt-done\npipx:http:\/\/mirror\/simple:mirror:noninteractive/,
  );
});

async function waitForLog(
  runner: PrerequisiteInstallRunner,
  pattern: RegExp,
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const match = runner.latest()?.log.match(pattern);
    if (match) return match;
    await setTimeout(20);
  }
  throw new Error(
    `Timed out waiting for installation log: ${runner.latest()?.log}`,
  );
}

async function assertProcessStopped(pid: number): Promise<void> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.match(stat.slice(stat.lastIndexOf(")") + 2), /^[ZX] /);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

test("cancellation kills descendants, skips success state and releases the slot", async (t) => {
  const runner = new PrerequisiteInstallRunner();
  let successes = 0;
  t.after(() => runner.cancel());
  runner.start({ scope: "all" }, "sleep 30 & echo ready:$!; wait", null, {
    onSucceeded: () => {
      successes += 1;
    },
  });
  const ready = await waitForLog(runner, /ready:(\d+)/);
  const cancel = runner.cancel();
  assert.equal(runner.isRunning(), true);
  assert.throws(
    () => runner.start({ scope: "all" }, "true", null),
    /already running/,
  );
  const [result, repeated] = await Promise.all([cancel, runner.cancel()]);
  assert.equal(result?.status, "canceled");
  assert.deepEqual(repeated, result);
  assert.ok(result?.finishedAt);
  assert.equal(successes, 0);
  await runner.waitForCompletion();
  await assertProcessStopped(Number(ready[1]));
  assert.deepEqual(await runner.cancel(), result);
  runner.start({ scope: "all" }, "echo next-run", null);
  await runner.waitForCompletion();
  assert.equal(runner.latest()?.status, "succeeded");
});

test("cancellation escalates for a TERM-ignoring descendant in another session", async (t) => {
  const runner = new PrerequisiteInstallRunner();
  t.after(() => runner.cancel());
  const script =
    "process.on('SIGTERM', () => {}); console.log('ready:' + process.pid); setTimeout(() => process.exit(0), 30000)";
  runner.start(
    { scope: "all" },
    `setsid ${shellQuote(process.execPath)} -e ${shellQuote(script)} & wait`,
    null,
  );
  const ready = await waitForLog(runner, /ready:(\d+)/);
  await runner.cancel();
  await assertProcessStopped(Number(ready[1]));
  assert.equal(runner.latest()?.status, "canceled");
});

test("cancellation reaches root-owned children behind sudo's PTY", async (t) => {
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 2000 });
  } catch {
    t.skip("passwordless sudo is unavailable");
    return;
  }
  const runner = new PrerequisiteInstallRunner();
  t.after(() => runner.cancel());
  const script =
    "process.on('SIGTERM', () => {}); console.log('ready:' + process.pid); setTimeout(() => process.exit(0), 30000)";
  runner.start(
    { checkId: "uv" },
    `sudo ${shellQuote(process.execPath)} -e ${shellQuote(script)} && echo unexpected-pipx`,
    "passwordless-sudo",
  );
  const ready = await waitForLog(runner, /ready:(\d+)/);
  await runner.cancel();
  await assertProcessStopped(Number(ready[1]));
  assert.equal(runner.latest()?.status, "canceled");
  assert.doesNotMatch(runner.latest()?.log ?? "", /unexpected-pipx/);
});

test("failed cancellation keeps the slot occupied and can be retried", async (t) => {
  const runner = new PrerequisiteInstallRunner();
  t.after(() => runner.cancel());
  runner.start({ scope: "all" }, "echo ready; sleep 30", null);
  await waitForLog(runner, /ready/);
  const terminate = t.mock.method(
    InstallProcessTree.prototype,
    "terminate",
    async () => {
      throw new Error("signal denied");
    },
  );
  await assert.rejects(runner.cancel(), /signal denied/);
  assert.equal(runner.isRunning(), true);
  assert.equal(runner.latest()?.finishedAt, null);
  assert.match(
    runner.latest()?.log ?? "",
    /Cancellation failed: signal denied/,
  );
  terminate.mock.restore();
  await runner.cancel();
  assert.equal(runner.latest()?.status, "canceled");
});

test("cancellation without an active run is harmless", async () => {
  const runner = new PrerequisiteInstallRunner();
  assert.equal(await runner.cancel(), null);
  runner.start({ scope: "all" }, "exit 0", null);
  await runner.waitForCompletion();
  assert.equal((await runner.cancel())?.status, "succeeded");
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

test("records post-install state only after a successful command", async () => {
  const completed: string[] = [];
  const succeeded = new PrerequisiteInstallRunner();
  succeeded.start({ checkId: "nvidia-driver" }, "exit 0", null, {
    onSucceeded: () => completed.push("nvidia-driver"),
  });
  await succeeded.waitForCompletion();
  assert.deepEqual(completed, ["nvidia-driver"]);

  const failed = new PrerequisiteInstallRunner();
  failed.start({ checkId: "nvidia-driver" }, "exit 1", null, {
    onSucceeded: () => completed.push("unexpected"),
  });
  await failed.waitForCompletion();
  assert.deepEqual(completed, ["nvidia-driver"]);
});

test("keeps a successful install successful when state recording warns", async () => {
  const runner = new PrerequisiteInstallRunner();
  runner.start({ checkId: "nvidia-driver" }, "exit 0", null, {
    onSucceeded: () => {
      throw new Error("marker unavailable");
    },
  });
  await runner.waitForCompletion();
  const run = runner.latest();
  assert.ok(run);
  assert.equal(run.status, "succeeded");
  assert.match(run.log, /post-install state warning: marker unavailable/);
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
