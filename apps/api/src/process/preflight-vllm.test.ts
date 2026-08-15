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
  };
}

test("vLLM preflight requires a model argument", async () => {
  const result = await validateInstancePreflight(instance());

  assert.equal(result.ok, false);
  assert.match(
    result.issues.find((issue) => issue.field === "positionalArgs")?.message ??
      "",
    /requires a model/i,
  );
});

test("vLLM preflight accepts a Hugging Face model id", async () => {
  const result = await validateInstancePreflight(instance("Qwen/Qwen3-4B"));

  assert.equal(result.ok, true);
});

test("vLLM preflight validates an explicit local model path", async () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-vllm-preflight-"));
  try {
    const model = join(root, "model");
    mkdirSync(model);
    assert.equal((await validateInstancePreflight(instance(model))).ok, true);

    const missing = await validateInstancePreflight(
      instance(join(root, "missing")),
    );
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

test("vLLM preflight resolves explicit relative local paths from cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-vllm-preflight-"));
  try {
    mkdirSync(join(root, "model"));
    const configured = { ...instance("./model"), cwd: root };
    assert.equal((await validateInstancePreflight(configured)).ok, true);

    const missing = await validateInstancePreflight({
      ...configured,
      positionalArgs: ["./missing"],
    });
    assert.equal(missing.ok, false);
    assert.match(missing.issues[0]?.message ?? "", /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
