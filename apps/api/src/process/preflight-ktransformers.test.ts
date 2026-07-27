import type {
  Instance,
  MemoryPool,
  NumaNode,
  SystemAccelerator,
} from "@arriero/core";
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

const now = "2026-01-01T00:00:00.000Z";
const pools: MemoryPool[] = [
  {
    id: "gpu0",
    name: "GPU 0",
    kind: "gpu",
    capacityBytes: 24_000,
    reservedBytes: 0,
    deviceRef: "0",
    autoCapacity: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "gpu1",
    name: "GPU 1",
    kind: "gpu",
    capacityBytes: 24_000,
    reservedBytes: 0,
    deviceRef: "1",
    autoCapacity: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "host",
    name: "Host RAM",
    kind: "host",
    capacityBytes: 128_000,
    reservedBytes: 0,
    deviceRef: null,
    autoCapacity: true,
    createdAt: now,
    updatedAt: now,
  },
];
const numaNodes: NumaNode[] = [0, 1].map((id) => ({
  id,
  cpus: id === 0 ? "0-7" : "8-15",
  cpuCount: 8,
  memoryBytes: 64_000,
  memFreeBytes: 32_000,
  filePagesBytes: 0,
  online: true,
}));

function preflightOptions(accelerators: SystemAccelerator[] = [nvidia]) {
  return { accelerators, memoryPools: pools, numaNodes };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arriero-kt-preflight-"));
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
    memory: [
      { poolId: "gpu0", bytes: 8_000 },
      { poolId: "host", bytes: 32_000 },
    ],
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
      ...preflightOptions(),
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
    const result = validateInstancePreflight(instance, preflightOptions([]));
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
      ...preflightOptions(),
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

test("KTransformers preflight requires host and every selected GPU reservation", () => {
  const { root, instance } = fixture();
  try {
    instance.env.CUDA_VISIBLE_DEVICES = "1,0";
    instance.args["--tensor-parallel-size"] = 2;
    instance.memory = [{ poolId: "gpu0", bytes: 8_000 }];
    const second = { ...nvidia, id: "1", name: "NVIDIA Test 1" };
    const result = validateInstancePreflight(instance, {
      ...preflightOptions([nvidia, second]),
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => /host-memory/.test(entry.message)));
    assert.ok(result.issues.some((entry) => /GPU 1/.test(entry.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight rejects GPU draws outside CUDA and TP order", () => {
  const { root, instance } = fixture();
  try {
    instance.env.CUDA_VISIBLE_DEVICES = "1,0";
    instance.memory = [
      { poolId: "gpu0", bytes: 8_000 },
      { poolId: "host", bytes: 32_000 },
    ];
    const second = { ...nvidia, id: "1", name: "NVIDIA Test 1" };
    const result = validateInstancePreflight(instance, {
      ...preflightOptions([nvidia, second]),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((entry) => /outside CUDA/.test(entry.message)),
    );
    assert.ok(result.issues.some((entry) => /GPU 1/.test(entry.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight validates internal and manager NUMA placement", () => {
  const { root, instance } = fixture();
  try {
    instance.args["--kt-threadpool-count"] = 2;
    instance.args["--kt-numa-nodes"] = ["0", "1"];
    instance.numa = { mode: "bind", node: 0 };
    const result = validateInstancePreflight(instance, preflightOptions());
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.field === "numa.node"));

    instance.numa = { mode: "interleave", nodes: [0, 1] };
    const interleave = validateInstancePreflight(instance, preflightOptions());
    assert.equal(interleave.ok, false);
    assert.ok(interleave.issues.some((entry) => entry.field === "numa.mode"));

    delete instance.numa;
    const noCpu = validateInstancePreflight(instance, {
      ...preflightOptions(),
      numaNodes: numaNodes.map((node) =>
        node.id === 1 ? { ...node, cpuCount: 0, cpus: "" } : node,
      ),
    });
    assert.equal(noCpu.ok, false);
    assert.ok(
      noCpu.issues.some((entry) => /no online CPU cores/.test(entry.message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers memory shortfalls are blocking", () => {
  const { root, instance } = fixture();
  try {
    const result = validateInstancePreflight(instance, {
      ...preflightOptions(),
      capacityAdmission: {
        ok: false,
        shortfalls: [
          {
            poolId: "host",
            requestedBytes: 32_000,
            availableBytes: 1_000,
            deficitBytes: 31_000,
          },
        ],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((entry) => /strict admission/.test(entry.message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
