import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLsRemoteRefs,
  resolveEnvironmentSourceRefs,
} from "./source-refs.js";

const LS_REMOTE_OUTPUT = [
  "1a2b3c\trefs/heads/main",
  "4d5e6f\trefs/heads/legacy",
  "7a8b9c\trefs/tags/v0.9.4",
  "0d1e2f\trefs/tags/v0.10.0",
  "3a4b5c\trefs/tags/v0.10.1",
  "6d7e8f\trefs/pull/123/head",
  "",
].join("\n");

test("tags sort newest first with numeric awareness, branches alphabetically", () => {
  const parsed = parseLsRemoteRefs(LS_REMOTE_OUTPUT);
  assert.deepEqual(parsed.tags, ["v0.10.1", "v0.10.0", "v0.9.4"]);
  assert.deepEqual(parsed.branches, ["legacy", "main"]);
});

test("non-tag non-head refs and blank lines are ignored", () => {
  const parsed = parseLsRemoteRefs("abc\trefs/pull/1/head\n\nnot-a-ref-line\n");
  assert.deepEqual(parsed, { tags: [], branches: [] });
});

test("engines without a git source resolve to null", async () => {
  assert.equal(await resolveEnvironmentSourceRefs("vllm"), null);
  assert.equal(await resolveEnvironmentSourceRefs("open-webui"), null);
});
