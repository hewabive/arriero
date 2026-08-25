import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { config } from "../config.js";
import {
  discardDirectory,
  isDiscardedDirectoryName,
  settleDirectoryDiscards,
} from "../utils/discard.js";
import { sweepEnvironmentLeftovers } from "./discard.js";

function makeEnvironmentTree(name: string) {
  const dir = resolve(config.envsDir, name);
  mkdirSync(resolve(dir, "bin"), { recursive: true });
  writeFileSync(resolve(dir, "bin", "python"), "");
  return dir;
}

test("discard frees the original path synchronously and removes the tree in background", async () => {
  const dir = makeEnvironmentTree("vllm-0.0.1-discardtest");
  discardDirectory(dir);
  assert.equal(existsSync(dir), false);
  await settleDirectoryDiscards();
  assert.equal(
    readdirSync(config.envsDir).some((name) =>
      name.startsWith("vllm-0.0.1-discardtest"),
    ),
    false,
  );
});

test("discarding a missing path is a no-op", async () => {
  const dir = resolve(config.envsDir, "vllm-0.0.1-absent");
  discardDirectory(dir);
  assert.equal(existsSync(dir), false);
  await settleDirectoryDiscards();
});

test("leftover sweep discards staging directories and removes trash entries", async () => {
  const staging = makeEnvironmentTree("vllm-0.0.1-sweeptest.staging");
  const trash = makeEnvironmentTree("vllm-0.0.1-sweeptest.old1.trash");
  assert.equal(
    isDiscardedDirectoryName("vllm-0.0.1-sweeptest.old1.trash"),
    true,
  );
  assert.equal(isDiscardedDirectoryName("vllm-0.0.1-sweeptest.staging"), false);
  const swept = sweepEnvironmentLeftovers();
  assert.ok(swept >= 2);
  assert.equal(existsSync(staging), false);
  await settleDirectoryDiscards();
  assert.equal(existsSync(trash), false);
  assert.equal(
    readdirSync(config.envsDir).some((name) => name.includes("sweeptest")),
    false,
  );
});
