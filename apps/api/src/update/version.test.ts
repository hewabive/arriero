import { strict as assert } from "node:assert";
import test from "node:test";

import { detectRunMode, isSupervised } from "./version.js";

test("detectRunMode classifies tsx dev entrypoints as dev", () => {
  assert.equal(detectRunMode("/home/u/repo/apps/api/src/index.ts"), "dev");
});

test("detectRunMode classifies compiled dist entrypoints as serve", () => {
  assert.equal(detectRunMode("/home/u/repo/apps/api/dist/index.js"), "serve");
  assert.equal(detectRunMode("C:\\app\\apps\\api\\dist\\index.js"), "serve");
});

test("detectRunMode is unknown for anything else", () => {
  assert.equal(detectRunMode(undefined), "unknown");
  assert.equal(detectRunMode("/usr/bin/node"), "unknown");
  assert.equal(detectRunMode("/home/u/repo/dist/worker.js"), "unknown");
});

test("isSupervised reflects the systemd INVOCATION_ID marker", () => {
  assert.equal(isSupervised({}), false);
  assert.equal(isSupervised({ INVOCATION_ID: "abc123" }), true);
});
