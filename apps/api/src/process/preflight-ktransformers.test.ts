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
  computeCapability: { major: 8, minor: 9 },
  source: "nvml",
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
  },
  {
    id: "gpu1",
    name: "GPU 1",
    kind: "gpu",
    capacityBytes: 24_000,
    reservedBytes: 0,
    deviceRef: "1",
    autoCapacity: true,
  },
  {
    id: "host",
    name: "Host RAM",
    kind: "host",
    capacityBytes: 128_000,
    reservedBytes: 0,
    deviceRef: null,
    autoCapacity: true,
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
  return {
    accelerators,
    memoryPools: pools,
    numaNodes,
    cpuFlags: ["avx2", "avx512f"],
    physicalCoreCount: 16,
    hostAvailableMemoryBytes: 128_000,
    swapTotalBytes: 0,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arriero-kt-preflight-"));
  const bin = join(root, "bin");
  const weights = join(root, "weights");
  mkdirSync(bin, { recursive: true });
  mkdirSync(weights, { recursive: true });
  writeFileSync(join(bin, "sglang"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "python"),
    '#!/bin/sh\nprintf \'ARRIERO_KT_RUNTIME=["3.12","0.6.3.post1","0.6.3.post1"]\\n\'\n',
    { mode: 0o755 },
  );
  const instance: Instance = {
    name: "kt-preflight",
    kind: "ktransformers",
    binaryPath: join(bin, "sglang"),
    binaryPathRefId: "kt-bin",
    args: {
      "--kt-cpuinfer": 16,
      "--kt-num-gpu-experts": 1,
    },
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
  };
  return { root, instance };
}

async function populateArgumentCatalogBeforeHangingProbe(instance: Instance) {
  assert.equal(
    (await validateInstancePreflight(instance, preflightOptions())).ok,
    true,
    "a passing preflight must cache the argument catalog while the real Python launcher is still in place",
  );
}

function installHangingRuntimeProbe(pythonPath: string) {
  writeFileSync(pythonPath, "#!/bin/sh\nwhile :; do :; done\n", {
    mode: 0o755,
  });
}

test("KTransformers preflight accepts a matched supported runtime", async () => {
  const { root, instance } = fixture();
  try {
    const result = await validateInstancePreflight(instance, {
      ...preflightOptions(),
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight blocks missing weights and CUDA", async () => {
  const { root, instance } = fixture();
  try {
    instance.engineConfig!.cpuWeights = join(root, "missing");
    const result = await validateInstancePreflight(
      instance,
      preflightOptions([]),
    );
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

test("KTransformers preflight rejects GPUs below the compute-capability floor", async () => {
  const { root, instance } = fixture();
  try {
    const pascal: SystemAccelerator = {
      ...nvidia,
      name: "NVIDIA GeForce GTX 1080 Ti",
      computeCapability: { major: 6, minor: 1 },
    };
    const result = await validateInstancePreflight(
      instance,
      preflightOptions([pascal]),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.field === "gpu" &&
          /compute capability 7\.5/.test(issue.message) &&
          /GTX 1080 Ti reports 6\.1/.test(issue.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight enforces loopback auth and tensor parallel limits", async () => {
  const { root, instance } = fixture();
  try {
    instance.args = {
      "--api-key": "secret",
      "--host": "0.0.0.0",
      "--tensor-parallel-size": 2,
    };
    const result = await validateInstancePreflight(instance, {
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

test("KTransformers preflight warns that proxy clients cannot send custom metric labels", async () => {
  const { root, instance } = fixture();
  try {
    instance.args = {
      ...instance.args,
      "--tokenizer-metrics-allowed-custom-labels": ["team"],
    };
    const result = await validateInstancePreflight(instance, {
      ...preflightOptions(),
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const warning = result.issues.find((issue) =>
      /proxy strips/.test(issue.message),
    );
    assert.equal(warning?.level, "warning");
    assert.equal(
      warning?.field,
      "args.--tokenizer-metrics-allowed-custom-labels",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight reads the SGLang --tp-size spelling", async () => {
  const { root, instance } = fixture();
  try {
    instance.args = { "--tp-size": 2 };
    const result = await validateInstancePreflight(instance, {
      ...preflightOptions(),
    });
    assert.ok(
      result.issues.some(
        (issue) => issue.field === "args.--tensor-parallel-size",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight requires host and every selected GPU reservation", async () => {
  const { root, instance } = fixture();
  try {
    instance.env.CUDA_VISIBLE_DEVICES = "1,0";
    instance.args["--tensor-parallel-size"] = 2;
    instance.memory = [{ poolId: "gpu0", bytes: 8_000 }];
    const second = { ...nvidia, id: "1", name: "NVIDIA Test 1" };
    const result = await validateInstancePreflight(instance, {
      ...preflightOptions([nvidia, second]),
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => /host-memory/.test(entry.message)));
    assert.ok(result.issues.some((entry) => /GPU 1/.test(entry.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight rejects GPU draws outside CUDA and TP order", async () => {
  const { root, instance } = fixture();
  try {
    instance.env.CUDA_VISIBLE_DEVICES = "1,0";
    instance.memory = [
      { poolId: "gpu0", bytes: 8_000 },
      { poolId: "host", bytes: 32_000 },
    ];
    const second = { ...nvidia, id: "1", name: "NVIDIA Test 1" };
    const result = await validateInstancePreflight(instance, {
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

test("KTransformers preflight validates internal and manager NUMA placement", async () => {
  const { root, instance } = fixture();
  try {
    instance.args["--kt-threadpool-count"] = 2;
    instance.args["--kt-numa-nodes"] = ["0", "1"];
    instance.numa = { mode: "bind", node: 0 };
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.field === "numa.node"));

    instance.numa = { mode: "interleave", nodes: [0, 1] };
    const interleave = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(interleave.ok, false);
    assert.ok(interleave.issues.some((entry) => entry.field === "numa.mode"));

    delete instance.numa;
    const noCpu = await validateInstancePreflight(instance, {
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

test("KTransformers preflight ignores manager NUMA placement on a single-node host", async () => {
  const { root, instance } = fixture();
  try {
    const options = { ...preflightOptions(), numaNodes: [numaNodes[0]!] };
    instance.numa = { mode: "interleave", nodes: [0, 1] };
    const interleave = await validateInstancePreflight(instance, options);
    assert.ok(!interleave.issues.some((entry) => entry.field === "numa.mode"));

    instance.numa = { mode: "bind", node: 1 };
    instance.args["--kt-numa-nodes"] = ["0"];
    const bind = await validateInstancePreflight(instance, options);
    assert.ok(!bind.issues.some((entry) => entry.field === "numa.node"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers memory shortfalls are blocking", async () => {
  const { root, instance } = fixture();
  try {
    const result = await validateInstancePreflight(instance, {
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

test("KTransformers preflight enforces the CPU method support matrix", async () => {
  const { root, instance } = fixture();
  try {
    const fp8 = await validateInstancePreflight(instance, {
      ...preflightOptions(),
      cpuFlags: ["avx2"],
    });
    assert.equal(fp8.ok, false);
    assert.ok(
      fp8.issues.some(
        (entry) =>
          entry.field === "engineConfig.method" &&
          /avx512f/.test(entry.message),
      ),
    );

    instance.engineConfig!.method = "BF16";
    const bf16 = await validateInstancePreflight(instance, {
      ...preflightOptions(),
      cpuFlags: ["avx2", "avx512f"],
    });
    assert.equal(bf16.ok, false);
    assert.ok(
      bf16.issues.some(
        (entry) =>
          entry.field === "engineConfig.method" &&
          /avx512_bf16/.test(entry.message),
      ),
    );

    instance.engineConfig!.method = "LLAMAFILE";
    const llamafile = await validateInstancePreflight(instance, {
      ...preflightOptions(),
      cpuFlags: ["avx2"],
    });
    assert.equal(llamafile.ok, true, JSON.stringify(llamafile.issues));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight validates CPU threads and GPU expert placement", async () => {
  const { root, instance } = fixture();
  try {
    instance.args["--kt-cpuinfer"] = 17;
    delete instance.args["--kt-num-gpu-experts"];
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "args.--kt-cpuinfer" &&
          /exceed 16 physical core/.test(entry.message),
      ),
    );
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "args.--kt-num-gpu-experts" &&
          /requires/.test(entry.message),
      ),
    );

    instance.args["--kt-cpuinfer"] = 16;
    instance.args["--kt-gpu-experts-ratio"] = 1.5;
    const ratio = await validateInstancePreflight(instance, preflightOptions());
    assert.equal(ratio.ok, false);
    assert.ok(
      ratio.issues.some(
        (entry) =>
          entry.field === "args.--kt-gpu-experts-ratio" &&
          /between 0 and 1/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight requires matching roots and versions RAWINT4 ISA", async () => {
  const { root, instance } = fixture();
  const python = join(root, "bin", "python");
  try {
    writeFileSync(
      python,
      '#!/bin/sh\nprintf \'ARRIERO_KT_RUNTIME=["3.12","0.6.3.post1","0.6.4"]\\n\'\n',
      { mode: 0o755 },
    );
    const mismatch = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(mismatch.ok, false);
    assert.ok(
      mismatch.issues.some(
        (entry) =>
          entry.field === "binaryPathRefId" &&
          /versions do not match/.test(entry.message),
      ),
    );

    writeFileSync(
      python,
      '#!/bin/sh\nprintf \'ARRIERO_KT_RUNTIME=["3.12","0.6.1","0.6.1"]\\n\'\n',
      { mode: 0o755 },
    );
    instance.engineConfig!.method = "RAWINT4";
    const oldRawInt4 = await validateInstancePreflight(instance, {
      ...preflightOptions(),
      cpuFlags: ["avx2"],
    });
    assert.equal(oldRawInt4.ok, false);
    assert.ok(
      oldRawInt4.issues.some(
        (entry) =>
          entry.field === "engineConfig.method" &&
          /avx512f/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers runtime probe timeout is configurable and diagnostic", async () => {
  const { root, instance } = fixture();
  const python = join(root, "bin", "python");
  try {
    await populateArgumentCatalogBeforeHangingProbe(instance);
    installHangingRuntimeProbe(python);
    const result = await validateInstancePreflight(instance, {
      ...preflightOptions(),
      runtimeProbeTimeoutMs: 10,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "binaryPathRefId" &&
          /timed out after 10 ms/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KTransformers preflight blocks a failing CPU-kernel smoke test", async () => {
  const { root, instance } = fixture();
  const python = join(root, "bin", "python");
  try {
    assert.equal(
      (await validateInstancePreflight(instance, preflightOptions())).ok,
      true,
    );
    writeFileSync(python, "#!/bin/sh\nexit 132\n", { mode: 0o755 });
    const result = await validateInstancePreflight(
      instance,
      preflightOptions(),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some(
        (entry) =>
          entry.field === "binaryPathRefId" &&
          /CPU-kernel smoke test failed/.test(entry.message),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
