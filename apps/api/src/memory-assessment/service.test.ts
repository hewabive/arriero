import {
  MEMORY_ESTIMATOR_VERSION,
  MemoryEstimateSchema,
  engineDescriptor,
  type Instance,
  type InstanceMemoryLayout,
  type MemoryEstimate,
} from "@arriero/core";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  createInstance,
  deleteInstance,
  getInstance,
  updateInstance,
} from "../instances/repository.js";
import {
  contextFromInstance,
  estimateMemory,
} from "../memory-estimate/service.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import {
  RESOURCES_FILE,
  resetResourcePoolsCache,
} from "../resources/repository.js";
import { assessmentEngine } from "./engines.js";
import { measuredComparisonDeltas } from "./measured.js";
import {
  drawsDigest,
  parseStoredReceipt,
  type AnalyticalReceipt,
  type MeasuredReceipt,
  type MemoryAssessmentFingerprint,
} from "./receipt.js";
import {
  bindMemoryAssessment,
  createMemoryAssessmentDraft,
  deleteMemoryAssessmentForInstance,
  getMemoryAssessmentForInstance,
  updateMemoryAssessmentReceipt,
} from "./repository.js";
import {
  bindMemoryAssessmentToInstance,
  createMemoryAssessment,
  evaluateInstanceMemoryAssessment,
} from "./service.js";

const MiB = 1024 * 1024;

function fingerprint(): MemoryAssessmentFingerprint {
  return {
    digest: "d",
    configDigest: "c",
    hardwareDigest: "h",
    binary: null,
    runtimeFiles: [],
    artifacts: [],
    currentBinaryPath: "",
  };
}

function estimate(gpuBytes: number, hostBytes: number) {
  const pools = [
    {
      poolId: "gpu0",
      kind: "gpu" as const,
      weightsBytes: gpuBytes,
      kvBytes: 0,
      computeBytes: 0,
      overheadBytes: 400 * MiB,
      totalBytes: gpuBytes + 400 * MiB,
    },
    {
      poolId: "host",
      kind: "host" as const,
      weightsBytes: hostBytes,
      kvBytes: 0,
      computeBytes: 0,
      overheadBytes: 0,
      totalBytes: hostBytes,
    },
  ];
  return MemoryEstimateSchema.parse({
    draws: pools.map((pool) => ({
      poolId: pool.poolId,
      bytes: pool.totalBytes,
    })),
    pools,
    weightsBytesTotal: gpuBytes + hostBytes,
    kvBytesTotal: 0,
    computeBytesTotal: 0,
    overheadBytesTotal: 400 * MiB,
    mmprojBytesTotal: 0,
    draftBytesTotal: 0,
    loraBytesTotal: 0,
    controlVectorBytesTotal: 0,
    selfMtpBytesTotal: 0,
    totalBytes: gpuBytes + hostBytes + 400 * MiB,
    context: {
      nCtx: 4096,
      nCtxSeq: 4096,
      nBatch: 512,
      nUbatch: 512,
      nSeqMax: 1,
      kvUnified: true,
      swaFull: false,
      flashAttn: true,
      typeK: "f16",
      typeV: "f16",
      offloadKqv: true,
      nGpuLayers: 32,
    },
    confidence: "high",
    warnings: [],
  });
}

function analyticalReceipt(
  value: MemoryEstimate,
  estimatorId = "llama.cpp-gguf",
): AnalyticalReceipt {
  return {
    schemaVersion: 1,
    evidence: "analytical",
    estimatorId,
    estimatorVersion: MEMORY_ESTIMATOR_VERSION,
    createdAt: "2026-08-05T00:00:00.000Z",
    fingerprint: fingerprint(),
    estimate: value,
    appliedDrawsDigest: null,
    validation: null,
  };
}

function layout(
  source: InstanceMemoryLayout["source"],
  deviceBytes: number,
  hostBytes: number,
): InstanceMemoryLayout {
  return {
    source,
    sourceDetail: null,
    processIds: [],
    entries: [],
    deviceBytes,
    hostBytes,
    otherBytes: 0,
    totalBytes: deviceBytes + hostBytes,
    projectedHostBytes: null,
    projectedHostTotalBytes: null,
  };
}

function storedInstance(name: string): Instance {
  const instance = getInstance(name);
  assert.ok(instance);
  return instance;
}

const llama = assessmentEngine("llama-server");
const vllm = assessmentEngine("vllm");

test("exact llama.cpp buffers verify an estimate within tolerance", () => {
  const result = llama?.analytical?.validate(
    analyticalReceipt(estimate(4_000 * MiB, 1_000 * MiB)),
    layout("log-buffers", 4_080 * MiB, 960 * MiB),
    null,
  );

  assert.equal(result?.verdict, "verified");
  assert.deepEqual(
    result?.deltas.map((entry) => entry.scope),
    ["gpu", "host"],
  );
});

test("exact llama.cpp buffers expose VRAM estimator drift", () => {
  const result = llama?.analytical?.validate(
    analyticalReceipt(estimate(4_000 * MiB, 1_000 * MiB)),
    layout("log-buffers", 5_000 * MiB, 1_000 * MiB),
    null,
  );

  assert.equal(result?.verdict, "mismatch");
  const gpu = result?.deltas.find((entry) => entry.scope === "gpu");
  assert.ok(gpu);
  assert.ok(gpu.deltaBytes > gpu.toleranceBytes);
});

test("process telemetry is not treated as a buffer-level verification", () => {
  const result = llama?.analytical?.validate(
    analyticalReceipt(estimate(4_000 * MiB, 1_000 * MiB)),
    layout("process-telemetry", 8_000 * MiB, 2_000 * MiB),
    "run-1",
  );

  assert.equal(result, null);
});

test("unclassified llama.cpp buffers do not produce a false verification", () => {
  const unknown = layout("log-buffers", 4_000 * MiB, 1_000 * MiB);
  unknown.otherBytes = 256 * MiB;
  unknown.totalBytes += unknown.otherBytes;
  const result = llama?.analytical?.validate(
    analyticalReceipt(estimate(4_000 * MiB, 1_000 * MiB)),
    unknown,
    null,
  );

  assert.equal(result?.verdict, "inconclusive");
});

test("vLLM reservation verifies against GPU telemetry within tolerance", () => {
  const result = vllm?.analytical?.validate(
    analyticalReceipt(estimate(20_000 * MiB, 0), "vllm-gpu-util"),
    layout("process-telemetry", 21_000 * MiB, 6_000 * MiB),
    "run-1",
  );

  assert.equal(result?.verdict, "verified");
  assert.deepEqual(
    result?.deltas.map((entry) => entry.scope),
    ["gpu"],
  );
});

test("vLLM reservation flags GPU telemetry outside tolerance", () => {
  const result = vllm?.analytical?.validate(
    analyticalReceipt(estimate(20_000 * MiB, 0), "vllm-gpu-util"),
    layout("process-telemetry", 12_000 * MiB, 0),
    "run-1",
  );

  assert.equal(result?.verdict, "mismatch");
});

test("vLLM reservation validation is scoped to an identified run", () => {
  const result = vllm?.analytical?.validate(
    analyticalReceipt(estimate(20_000 * MiB, 0), "vllm-gpu-util"),
    layout("process-telemetry", 21_000 * MiB, 0),
    null,
  );

  assert.equal(result, null);
});

test("vLLM analytical reservation owns GPU draws but allows manual host RAM", () => {
  writeFileSync(
    RESOURCES_FILE,
    `${JSON.stringify([
      {
        id: "gpu0",
        name: "GPU 0",
        kind: "gpu",
        capacityBytes: 10_000,
        reservedBytes: 0,
        deviceRef: "0",
        autoCapacity: false,
      },
      {
        id: "gpu1",
        name: "GPU 1",
        kind: "gpu",
        capacityBytes: 20_000,
        reservedBytes: 0,
        deviceRef: "1",
        autoCapacity: false,
      },
      {
        id: "host",
        name: "Host RAM",
        kind: "host",
        capacityBytes: 100_000,
        reservedBytes: 0,
        deviceRef: null,
        autoCapacity: false,
      },
    ])}\n`,
  );
  resetResourcePoolsCache();
  const binary = createPathCatalogEntry({
    kind: "binary",
    name: `vllm-assessment-${Date.now()}`,
    path: process.execPath,
    engineKind: "vllm",
  });
  const name = `vllm-reservation-${Date.now()}`;

  try {
    const input = {
      kind: "vllm" as const,
      binaryPathRefId: binary.id,
      args: { "--gpu-memory-utilization": 0.5 },
      positionalArgs: ["Qwen/Qwen3-0.6B"],
      env: { CUDA_VISIBLE_DEVICES: "0" },
    };
    const result = estimateMemory(input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const assessmentId = createMemoryAssessment(result);
    assert.ok(assessmentId);
    createInstance({
      name,
      ...input,
      memory: [...result.estimate.draws, { poolId: "host", bytes: 4_000 }],
      rpcWorkers: [],
    });

    const bound = bindMemoryAssessmentToInstance(assessmentId, name);
    assert.equal(bound.reservationStatus, "applied");

    const stored = getMemoryAssessmentForInstance(name);
    assert.ok(stored);
    const legacyReceipt = parseStoredReceipt(stored.receipt);
    assert.equal(legacyReceipt?.evidence, "analytical");
    if (legacyReceipt?.evidence === "analytical") {
      updateMemoryAssessmentReceipt(stored.id, {
        ...legacyReceipt,
        appliedDrawsDigest: null,
      });
    }
    assert.equal(
      evaluateInstanceMemoryAssessment(storedInstance(name))?.reservationStatus,
      "applied",
    );
    bindMemoryAssessmentToInstance(assessmentId, name);

    updateInstance(name, {
      memory: [...result.estimate.draws, { poolId: "host", bytes: 8_000 }],
    });
    assert.equal(
      evaluateInstanceMemoryAssessment(storedInstance(name))?.reservationStatus,
      "applied",
    );

    updateInstance(name, {
      memory: [
        { poolId: "gpu0", bytes: result.estimate.draws[0]!.bytes + 1 },
        { poolId: "host", bytes: 8_000 },
      ],
    });
    assert.equal(
      evaluateInstanceMemoryAssessment(storedInstance(name))?.reservationStatus,
      "modified",
    );

    updateInstance(name, {
      memory: [
        ...result.estimate.draws,
        { poolId: "gpu1", bytes: 1 },
        { poolId: "host", bytes: 8_000 },
      ],
    });
    assert.equal(
      evaluateInstanceMemoryAssessment(storedInstance(name))?.reservationStatus,
      "modified",
    );
  } finally {
    deleteInstance(name);
    rmSync(RESOURCES_FILE, { force: true });
    resetResourcePoolsCache();
  }
});

test("measured comparison stays within telemetry tolerance", () => {
  const deltas = measuredComparisonDeltas(
    {
      deviceBytes: 8_000 * MiB,
      hostBytes: 4_000 * MiB,
      mmapBytes: 2_000 * MiB,
    },
    {
      deviceBytes: 8_100 * MiB,
      hostBytes: 4_200 * MiB,
      mmapBytes: 2_000 * MiB,
    },
  );

  assert.equal(deltas.length, 2);
  assert.ok(
    deltas.every((entry) => Math.abs(entry.deltaBytes) <= entry.toleranceBytes),
  );
});

test("measured comparison flags growth beyond tolerance", () => {
  const deltas = measuredComparisonDeltas(
    { deviceBytes: 8_000 * MiB, hostBytes: 4_000 * MiB, mmapBytes: 0 },
    { deviceBytes: 8_000 * MiB, hostBytes: 6_000 * MiB, mmapBytes: 0 },
  );

  const host = deltas.find((entry) => entry.scope === "host");
  assert.ok(host);
  assert.ok(host.deltaBytes > host.toleranceBytes);
});

test("a v1 receipt without an evidence field parses as analytical", () => {
  const receipt = analyticalReceipt(estimate(4_000 * MiB, 1_000 * MiB));
  const stored = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
  delete stored.evidence;
  const parsed = parseStoredReceipt(stored);

  assert.equal(parsed?.evidence, "analytical");
});

test("a measured receipt round-trips through the stored parser", () => {
  const parsed = parseStoredReceipt({
    schemaVersion: 1,
    evidence: "measured",
    baselineVersion: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    fingerprint: fingerprint(),
    observation: {
      capturedAt: "2026-08-05T00:00:00.000Z",
      runId: "run-1",
      processIds: [4242],
      deviceBytes: 8_000 * MiB,
      hostBytes: 4_000 * MiB,
      mmapBytes: 2_000 * MiB,
      draws: [{ poolId: "gpu0", bytes: 8_000 * MiB }],
      notes: [],
    },
    previousBaseline: null,
    proposedDrawsDigest: "digest",
    validation: null,
  });

  assert.equal(parsed?.evidence, "measured");
});

test("an unreadable receipt fails closed", () => {
  assert.equal(parseStoredReceipt({ schemaVersion: 99 }), null);
  assert.equal(parseStoredReceipt(null), null);
});

function vllmInstance(name: string): Instance {
  return {
    name,
    kind: "vllm",
    binaryPath: "/nonexistent/vllm-env/bin/vllm",
    binaryPathRefId: "test-ref",
    args: {},
    positionalArgs: ["test-model"],
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "running",
    pid: null,
  };
}

test("a measured baseline evaluates, re-verifies per run, and goes stale on config change", () => {
  const name = `assessment-service-${Date.now()}`;
  const instance = vllmInstance(name);
  const engine = assessmentEngine("vllm");
  assert.ok(engine);

  assert.equal(
    evaluateInstanceMemoryAssessment(instance)?.status,
    "not-assessed",
  );

  const receipt: MeasuredReceipt = {
    schemaVersion: 1,
    evidence: "measured",
    baselineVersion: 1,
    createdAt: "2026-08-05T00:00:00.000Z",
    fingerprint: engine.buildFingerprint(contextFromInstance(instance)),
    observation: {
      capturedAt: "2026-08-05T00:00:00.000Z",
      runId: "run-1",
      processIds: [4242],
      deviceBytes: 8_000 * MiB,
      hostBytes: 4_000 * MiB,
      mmapBytes: 0,
      draws: [],
      notes: [],
    },
    previousBaseline: null,
    proposedDrawsDigest: drawsDigest([]),
    validation: null,
  };
  const draft = createMemoryAssessmentDraft(receipt);
  bindMemoryAssessment(draft.id, name, receipt);

  const sameRun = evaluateInstanceMemoryAssessment(instance, {
    layout: layout("process-telemetry", 8_000 * MiB, 4_000 * MiB),
    runId: "run-1",
  });
  assert.equal(sameRun?.status, "measured");
  assert.equal(sameRun?.evidence, "measured");
  assert.equal(sameRun?.baseline?.deviceBytes, 8_000 * MiB);

  const verified = evaluateInstanceMemoryAssessment(instance, {
    layout: layout("process-telemetry", 8_100 * MiB, 4_100 * MiB),
    runId: "run-2",
  });
  assert.equal(verified?.status, "verified");
  assert.equal(verified?.validationSource, "process-telemetry");

  const mismatch = evaluateInstanceMemoryAssessment(instance, {
    layout: layout("process-telemetry", 8_000 * MiB, 7_000 * MiB),
    runId: "run-3",
  });
  assert.equal(mismatch?.status, "mismatch");

  const persisted = evaluateInstanceMemoryAssessment(instance, {
    runId: "run-3",
  });
  assert.equal(persisted?.status, "mismatch");
  assert.equal(persisted?.validationSource, "process-telemetry");

  const changed: Instance = {
    ...instance,
    args: { "--max-model-len": "8192" },
  };
  assert.equal(
    evaluateInstanceMemoryAssessment(changed, { runId: "run-3" })?.status,
    "update-required",
  );

  deleteMemoryAssessmentForInstance(name);
});

test("rpc-worker has no assessment engine", () => {
  assert.equal(assessmentEngine("rpc-worker"), null);
});

test("ktransformers has a measured-only assessment engine", () => {
  const engine = assessmentEngine("ktransformers");
  assert.ok(engine);
  assert.equal(engine.analytical, null);
  assert.equal(
    engineDescriptor("ktransformers").assessment.measuredBaseline,
    true,
  );
});
