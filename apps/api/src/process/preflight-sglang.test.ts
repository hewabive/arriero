import type { Instance, SystemAccelerator } from "@arriero/core";
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
  computeCapability: { major: 8, minor: 9 },
  source: "nvml",
};

function preflightOptions(accelerators: SystemAccelerator[] = [nvidia]) {
  return { accelerators };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arriero-sglang-preflight-"));
  const bin = join(root, "bin");
  const model = join(root, "model");
  mkdirSync(bin, { recursive: true });
  mkdirSync(model, { recursive: true });
  writeFileSync(join(bin, "sglang"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "python"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const instance: Instance = {
    name: "sglang-preflight",
    kind: "sglang",
    binaryPath: join(bin, "sglang"),
    binaryPathRefId: "sglang-bin",
    args: {
      "--model-path": model,
    },
    env: { CUDA_VISIBLE_DEVICES: "0" },
    memory: [],
    rpcWorkers: [],
    scheduling: { evictionPolicy: "preemptible" },
    status: "stopped",
    pid: null,
  };
  return { root, instance };
}

test("SGLang preflight passes for a local model with a visible GPU", async () => {
  const { root, instance } = fixture();
  try {
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.level === "warning" &&
          entry.field === "args.--mem-fraction-static",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang preflight requires a model path", async () => {
  const { root, instance } = fixture();
  try {
    delete instance.args["--model-path"];
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.level === "error" && entry.field === "args.--model-path",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang preflight accepts a Hugging Face id with a download warning", async () => {
  const { root, instance } = fixture();
  try {
    instance.args["--model-path"] = "Qwen/Qwen3.5-35B-A3B-FP8";
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.level === "warning" &&
          entry.field === "args.--model-path" &&
          /download/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang preflight rejects a missing local model path", async () => {
  const { root, instance } = fixture();
  try {
    instance.args["--model-path"] = join(root, "missing-model");
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.level === "error" &&
          entry.field === "args.--model-path" &&
          /does not exist/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang tensor parallel size cannot exceed visible GPUs", async () => {
  const { root, instance } = fixture();
  try {
    instance.args["--tp-size"] = 2;
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((entry) =>
        /Tensor parallel size 2 exceeds 1 visible/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang preflight enforces the managed boundary", async () => {
  const { root, instance } = fixture();
  try {
    instance.args["--api-key"] = "secret";
    instance.args["--host"] = "0.0.0.0";
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "args.--api-key" &&
          /Managed SGLang/.test(entry.message),
      ),
    );
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "args.--host" && /loopback/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang preflight requires an NVIDIA GPU", async () => {
  const { root, instance } = fixture();
  try {
    const result = await validateInstancePreflight(
      instance,
      preflightOptions([]),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "env.CUDA_VISIBLE_DEVICES" &&
          /SGLang requires an NVIDIA GPU/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SGLang memory shortfalls warn instead of blocking", async () => {
  const { root, instance } = fixture();
  try {
    const result = await validateInstancePreflight(instance, {
      ...preflightOptions(),
      capacityAdmission: {
        ok: false,
        shortfalls: [
          {
            poolId: "gpu0",
            requestedBytes: 32_000,
            availableBytes: 1_000,
            deficitBytes: 31_000,
            missing: false,
          },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.level === "warning" &&
          entry.field === "memory" &&
          /require confirmation/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
