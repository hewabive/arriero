import type {
  Instance,
  ProcessPreflightIssue,
  SystemAccelerator,
} from "@arriero/core";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { environmentEntrypoint } from "../envs/paths.js";
import { createEnvironmentSpec } from "../envs/repository.js";
import { validateInstancePreflight } from "./preflight.js";
import { validateVllmPreflight } from "./preflight-vllm.js";

function instance(model?: string): Instance {
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

const pascal: SystemAccelerator = {
  id: "0",
  name: "NVIDIA GeForce GTX 1080 Ti",
  vendor: "NVIDIA",
  kind: "gpu",
  totalMemoryBytes: 1,
  availableMemoryBytes: 1,
  memoryUsedRatio: 0,
  utilizationPercent: 0,
  temperatureC: null,
  numaNode: null,
  computeCapability: { major: 6, minor: 1 },
  source: "nvml",
};

const ampere: SystemAccelerator = {
  ...pascal,
  id: "1",
  name: "NVIDIA RTX A6000",
  computeCapability: { major: 8, minor: 6 },
};

const unknownCapability: SystemAccelerator = {
  ...pascal,
  name: "NVIDIA Unknown",
  computeCapability: null,
};

function environmentInstance(
  variant: "cuda" | "cpu",
  overrides: Partial<Instance> = {},
): Instance {
  const spec = createEnvironmentSpec({
    engine: "vllm",
    version: `0.27.1-${variant}`,
    variant,
    pythonVersion: "3.12",
    source: { kind: "pypi", extras: [] },
  });
  return {
    ...instance("Qwen/Qwen3-4B"),
    binaryPath: environmentEntrypoint(spec),
    ...overrides,
  };
}

function gpuIssues(target: Instance, accelerators: SystemAccelerator[]) {
  const issues: ProcessPreflightIssue[] = [];
  validateVllmPreflight(target, issues, { accelerators });
  return issues;
}

test("vLLM preflight requires a model argument", async () => {
  const result = await validateInstancePreflight(instance(), {
    accelerators: [],
  });

  assert.equal(result.ok, false);
  assert.match(
    result.issues.find((issue) => issue.field === "positionalArgs")?.message ??
      "",
    /requires a model/i,
  );
});

test("vLLM preflight accepts a Hugging Face model id", async () => {
  const result = await validateInstancePreflight(instance("Qwen/Qwen3-4B"), {
    accelerators: [],
  });

  assert.equal(result.ok, true);
});

test("vLLM preflight validates an explicit local model path", async () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-vllm-preflight-"));
  try {
    const model = join(root, "model");
    mkdirSync(model);
    assert.equal(
      (await validateInstancePreflight(instance(model), { accelerators: [] }))
        .ok,
      true,
    );

    const missing = await validateInstancePreflight(
      instance(join(root, "missing")),
      { accelerators: [] },
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
    assert.equal(
      (await validateInstancePreflight(configured, { accelerators: [] })).ok,
      true,
    );

    const missing = await validateInstancePreflight(
      {
        ...configured,
        positionalArgs: ["./missing"],
      },
      { accelerators: [] },
    );
    assert.equal(missing.ok, false);
    assert.match(missing.issues[0]?.message ?? "", /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vLLM CUDA environments require an NVIDIA GPU", () => {
  const issues = gpuIssues(environmentInstance("cuda"), []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, "error");
  assert.equal(issues[0]?.field, "gpu");
  assert.match(issues[0]?.message ?? "", /NVIDIA GPU/);
});

test("vLLM CUDA environments reject GPUs below the compute-capability floor", () => {
  const issues = gpuIssues(environmentInstance("cuda"), [pascal]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, "error");
  assert.equal(issues[0]?.field, "gpu");
  assert.match(issues[0]?.message ?? "", /compute capability 7\.5/);
  assert.match(issues[0]?.message ?? "", /GTX 1080 Ti reports 6\.1/);

  assert.deepEqual(
    gpuIssues(environmentInstance("cuda"), [pascal, ampere]),
    [],
  );
  assert.deepEqual(
    gpuIssues(environmentInstance("cuda"), [unknownCapability]),
    [],
  );
});

test("vLLM preflight blames CUDA_VISIBLE_DEVICES when it hides the capable GPU", () => {
  const narrowed = environmentInstance("cuda", {
    env: { CUDA_VISIBLE_DEVICES: "0" },
  });
  const issues = gpuIssues(narrowed, [pascal, ampere]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.field, "env.CUDA_VISIBLE_DEVICES");
  assert.match(issues[0]?.message ?? "", /compute capability 7\.5/);

  const capable = environmentInstance("cuda", {
    env: { CUDA_VISIBLE_DEVICES: "1" },
  });
  assert.deepEqual(gpuIssues(capable, [pascal, ampere]), []);
});

test("vLLM CUDA environments cannot start with CUDA devices disabled", () => {
  const disabled = environmentInstance("cuda", {
    env: { CUDA_VISIBLE_DEVICES: "" },
  });
  const issues = gpuIssues(disabled, [ampere]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, "error");
  assert.equal(issues[0]?.field, "env.CUDA_VISIBLE_DEVICES");
  assert.match(issues[0]?.message ?? "", /CUDA devices disabled/);
});

test("vLLM CPU environments skip GPU checks", () => {
  assert.deepEqual(gpuIssues(environmentInstance("cpu"), []), []);
  assert.deepEqual(gpuIssues(environmentInstance("cpu"), [pascal]), []);
});

test("unmanaged vLLM binaries downgrade the capability check to a warning", () => {
  const issues = gpuIssues(instance("Qwen/Qwen3-4B"), [pascal]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, "warning");
  assert.equal(issues[0]?.field, "gpu");
  assert.match(issues[0]?.message ?? "", /compute capability 7\.5/);

  assert.deepEqual(gpuIssues(instance("Qwen/Qwen3-4B"), []), []);
});
