import { strict as assert } from "node:assert";
import test from "node:test";

import { buildSyncFlags, readDistBuildCommit } from "./build-info.js";

test("buildSyncFlags flags a checkout ahead of the last build", () => {
  assert.deepEqual(
    buildSyncFlags({ headCommit: "b", distCommit: "a", runningCommit: "a" }),
    { buildPending: true, restartPending: false },
  );
});

test("buildSyncFlags flags a build the process has not loaded", () => {
  assert.deepEqual(
    buildSyncFlags({ headCommit: "b", distCommit: "b", runningCommit: "a" }),
    { buildPending: false, restartPending: true },
  );
});

test("buildSyncFlags reports both skews after a pull with a stale process", () => {
  assert.deepEqual(
    buildSyncFlags({ headCommit: "c", distCommit: "b", runningCommit: "a" }),
    { buildPending: true, restartPending: true },
  );
});

test("buildSyncFlags is all-clear when checkout, build and process agree", () => {
  assert.deepEqual(
    buildSyncFlags({ headCommit: "b", distCommit: "b", runningCommit: "b" }),
    { buildPending: false, restartPending: false },
  );
});

test("buildSyncFlags stays unknown when a side is unmeasured", () => {
  assert.deepEqual(
    buildSyncFlags({ headCommit: "b", distCommit: null, runningCommit: null }),
    { buildPending: null, restartPending: null },
  );
  assert.deepEqual(
    buildSyncFlags({ headCommit: null, distCommit: "a", runningCommit: null }),
    { buildPending: null, restartPending: null },
  );
});

test("readDistBuildCommit returns null when no stamp exists", () => {
  assert.equal(readDistBuildCommit(), null);
});
