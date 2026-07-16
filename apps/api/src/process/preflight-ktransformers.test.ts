import type { Instance, SystemAccelerator } from "@llama-manager/core";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateInstancePreflight } from "./preflight.js";

const nvidia: SystemAccelerator = {
  id: "0",
  name: "NVIDIA Test",
  vendor: "NVIDIA",
  kind: "gpu",
  totalMemoryBytes: 1,
  availableMemoryBytes: 1,
  memoryUsedRatio: 0,
  utilizationPercent: 0,
  temperatureC: null,
  numaNode: 0,
  source: "nvidia-smi",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "llama-manager-kt-preflight-"));
  const bin = join(root, "bin");
  const weights = join(root, "weights");
  mkdirSync(bin, { recursive: true });
  mkdirSync(weights, { recursive: true });
  writeFileSync(join(bin, "sglang"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "python"), "#!/bin/sh\necho 3.12\n", {
    mode: 0o755,
  });
  const instance: Instance = {
    name: "kt-preflight",
    kind: "ktransformers",
    binaryPath: join(bin, "sglang"),
    binaryPathRefId: "kt-bin",
    args: {},
    env: { CUDA_VISIBLE_DEVICES: "0" },
    memory: [],
    rpcWorkers: [],
    engineConfig: {
      type: "ktransformers",
      model: "deepseek-ai/DeepSeek-V3",
      cpuWeights: weights,
      method: "FP8",
    },
    scheduling: { evictionPolicy: "idle-only" },
    status: "stopped",
    pid: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { root, instance };
}

test("KTransformers preflight accepts a matched supported runtime", () => {
  const { root, instance } = fixture();
  try {
    const result = validateInstancePreflight(instance, {
      accelerators: [nvidia],
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight blocks missing weights and CUDA", () => {
  const { root, instance } = fixture();
  try {
    instance.engineConfig!.cpuWeights = join(root, "missing");
    const result = validateInstancePreflight(instance, { accelerators: [] });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => issue.field === "engineConfig.cpuWeights"),
    );
    assert.ok(
      result.issues.some((issue) => issue.field === "env.CUDA_VISIBLE_DEVICES"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight enforces loopback auth and tensor parallel limits", () => {
  const { root, instance } = fixture();
  try {
    instance.args = {
      "--api-key": "secret",
      "--host": "0.0.0.0",
      "--tensor-parallel-size": 2,
    };
    const result = validateInstancePreflight(instance, {
      accelerators: [nvidia],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.field === "args.--api-key"));
    assert.ok(result.issues.some((issue) => issue.field === "args.--host"));
    assert.ok(
      result.issues.some(
        (issue) => issue.field === "args.--tensor-parallel-size",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
