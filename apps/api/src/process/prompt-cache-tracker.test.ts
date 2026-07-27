import assert from "node:assert/strict";
import test from "node:test";

import type { ProcessEvent } from "@arriero/core";

import { PromptCacheTracker } from "./prompt-cache-tracker.js";

function event(
  type: ProcessEvent["type"],
  instanceId: string,
  message: string,
): ProcessEvent {
  return { type, instanceId, message, timestamp: "2026-06-08T00:00:00.000Z" };
}

const STATE_LINE =
  "5.10.123 I srv        update:  - cache state: 3 prompts, 142.880 MiB (limits: 8192.000 MiB, 0 tokens, 0 est)\n";
const NO_LIMIT_LINE =
  "5.11.456 I srv        update:  - cache state: 1 prompts, 47.500 MiB (limits: 0.000 MiB, 0 tokens, 0 est)\n";

test("parses prompt cache state with a size limit", () => {
  const tracker = new PromptCacheTracker();
  tracker.observe(event("log", "inst", STATE_LINE));
  assert.deepEqual(tracker.get("inst"), {
    prompts: 3,
    sizeMiB: 142.88,
    limitMiB: 8192,
    at: "2026-06-08T00:00:00.000Z",
  });
});

test("treats a zero limit as no limit", () => {
  const tracker = new PromptCacheTracker();
  tracker.observe(event("log", "inst", NO_LIMIT_LINE));
  assert.equal(tracker.get("inst")?.limitMiB, null);
});

test("keeps only the latest state per instance", () => {
  const tracker = new PromptCacheTracker();
  tracker.observe(event("log", "inst", STATE_LINE));
  tracker.observe(event("log", "inst", NO_LIMIT_LINE));
  assert.equal(tracker.get("inst")?.prompts, 1);
});

test("clears state on instance exit", () => {
  const tracker = new PromptCacheTracker();
  tracker.observe(event("log", "inst", STATE_LINE));
  tracker.observe(event("exit", "inst", "exit code=0"));
  assert.equal(tracker.get("inst"), null);
});

test("reassembles a state line split across chunks", () => {
  const tracker = new PromptCacheTracker();
  tracker.observe(event("log", "inst", STATE_LINE.slice(0, 30)));
  assert.equal(tracker.get("inst"), null);
  tracker.observe(event("log", "inst", STATE_LINE.slice(30)));
  assert.equal(tracker.get("inst")?.prompts, 3);
});

test("ignores unrelated lines", () => {
  const tracker = new PromptCacheTracker();
  tracker.observe(
    event("log", "inst", "5.10.000 I srv  update_slots: all slots are idle\n"),
  );
  assert.equal(tracker.get("inst"), null);
});
