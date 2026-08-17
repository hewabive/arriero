import { strict as assert } from "node:assert";
import test from "node:test";

import { AppVersionSchema, type AppVersion } from "@arriero/core";

import { restartBlockedReason, withStartedAt } from "./restart.js";

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

test("AppVersionSchema defaults startedAt to null for older peers", () => {
  assert.equal(version(true).startedAt, null);
});

test("withStartedAt stamps a stable process start time", () => {
  const stamped = withStartedAt(version(true));
  assert.ok(stamped.startedAt);
  assert.equal(withStartedAt(version(false)).startedAt, stamped.startedAt);
});

test("restartBlockedReason allows supervised processes", () => {
  assert.equal(restartBlockedReason(true), null);
});

test("restartBlockedReason refuses without a supervisor", () => {
  assert.match(restartBlockedReason(false) ?? "", /supervisor/);
});
