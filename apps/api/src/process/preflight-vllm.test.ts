import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateInstancePreflight } from "./preflight.js";

function instance(model?: string): Instance {
  const timestamp = "2026-07-30T00:00:00.000Z";
  return {
    name: "vllm-preflight",
    kind: "vllm",
    binaryPath: process.execPath,
    binaryPathRefId: "binary-ref",
    args: { "--port": 8000 },
    ...(model === undefined ? {} : { positionalArgs: [model] }),
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "stopped",
    pid: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("vLLM preflight requires a model argument", () => {
  const result = validateInstancePreflight(instance());

  assert.equal(result.ok, false);
  assert.match(
    result.issues.find((issue) => issue.field === "positionalArgs")?.message ??
      "",
    /requires a model/i,
  );
});

test("vLLM preflight accepts a Hugging Face model id", () => {
  const result = validateInstancePreflight(instance("Qwen/Qwen3-4B"));

  assert.equal(result.ok, true);
});

test("vLLM preflight validates an explicit local model path", () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-vllm-preflight-"));
  try {
    const model = join(root, "model");
    mkdirSync(model);
    assert.equal(validateInstancePreflight(instance(model)).ok, true);

    const missing = validateInstancePreflight(instance(join(root, "missing")));
    assert.equal(missing.ok, false);
    assert.match(
      missing.issues.find((issue) => issue.field === "positionalArgs.0")
        ?.message ?? "",
      /not found/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vLLM preflight resolves explicit relative local paths from cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-vllm-preflight-"));
  try {
    mkdirSync(join(root, "model"));
    const configured = { ...instance("./model"), cwd: root };
    assert.equal(validateInstancePreflight(configured).ok, true);

    const missing = validateInstancePreflight({
      ...configured,
      positionalArgs: ["./missing"],
    });
    assert.equal(missing.ok, false);
    assert.match(missing.issues[0]?.message ?? "", /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
