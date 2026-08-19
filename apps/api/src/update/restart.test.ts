import { strict as assert } from "node:assert";
import test from "node:test";

import { AppVersionSchema, type AppVersion } from "@arriero/core";

import { restartBlockedReason, withRuntimeInfo } from "./restart.js";

function version(supervised: boolean): AppVersion {
  return AppVersionSchema.parse({
    commit: null,
    shortCommit: null,
    committedAt: null,
    branch: null,
    dirty: false,
    isGitRepo: false,
    mode: "serve",
    supervised,
    canUpdate: true,
    updateBlockedReason: null,
    behindCount: null,
    upstreamCommit: null,
    updateAvailable: false,
    lastCheckedAt: null,
  });
}

test("AppVersionSchema defaults runtime fields to null for older peers", () => {
  const parsed = version(true);
  assert.equal(parsed.startedAt, null);
  assert.equal(parsed.builtCommit, null);
  assert.equal(parsed.runningCommit, null);
  assert.equal(parsed.buildPending, null);
  assert.equal(parsed.restartPending, null);
});

test("withRuntimeInfo stamps a stable process start time", () => {
  const stamped = withRuntimeInfo(version(true));
  assert.ok(stamped.startedAt);
  assert.equal(withRuntimeInfo(version(false)).startedAt, stamped.startedAt);
});

test("withRuntimeInfo keeps build-sync flags unknown without a build stamp", () => {
  const stamped = withRuntimeInfo(version(true));
  assert.equal(stamped.builtCommit, null);
  assert.equal(stamped.buildPending, null);
  assert.equal(stamped.restartPending, null);
});

test("restartBlockedReason allows supervised processes", () => {
  assert.equal(restartBlockedReason(true), null);
});

test("restartBlockedReason refuses without a supervisor", () => {
  assert.match(restartBlockedReason(false) ?? "", /supervisor/);
});
