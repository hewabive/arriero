import assert from "node:assert/strict";
import test from "node:test";

import { runLoggedCommand, type CommandLog } from "./exec.js";

function collectingLog(): { log: CommandLog; written: string[] } {
  const written: string[] = [];
  return {
    written,
    log: { write: (chunk) => written.push(String(chunk)) },
  };
}

test("runLoggedCommand streams output to the log and reports the exit code", async () => {
  const { log, written } = collectingLog();
  const result = await runLoggedCommand(
    ["node", "-e", "console.log('out'); console.error('err')"],
    { log },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.ok(written.join("").includes("out"));
  assert.ok(written.join("").includes("err"));
});

test("runLoggedCommand collects stdout when asked", async () => {
  const { log } = collectingLog();
  const result = await runLoggedCommand(
    ["node", "-e", "process.stdout.write('captured'); process.exit(3)"],
    { log, collectStdout: true },
  );

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "captured");
});

test("runLoggedCommand rejects an empty command", async () => {
  const { log } = collectingLog();
  await assert.rejects(runLoggedCommand([], { log }), /must not be empty/);
});

test("runLoggedCommand rejects when the executable is missing", async () => {
  const { log } = collectingLog();
  await assert.rejects(
    runLoggedCommand(["definitely-not-a-real-binary-xyz"], { log }),
  );
});

test("runLoggedCommand kills the process on abort", async () => {
  const { log, written } = collectingLog();
  const controller = new AbortController();
  const pending = runLoggedCommand(
    ["node", "-e", "console.log('up'); setInterval(() => {}, 1000)"],
    { log, signal: controller.signal },
  );
  await new Promise((resolveDone) => setTimeout(resolveDone, 300));
  controller.abort();

  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.ok(written.join("").includes("# terminated by"));
});

test("runLoggedCommand kills immediately when the signal is already aborted", async () => {
  const { log } = collectingLog();
  const controller = new AbortController();
  controller.abort();

  const result = await runLoggedCommand(
    ["node", "-e", "setInterval(() => {}, 1000)"],
    { log, signal: controller.signal },
  );
  assert.equal(result.exitCode, 1);
});
