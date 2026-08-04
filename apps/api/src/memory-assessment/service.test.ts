import { MemoryEstimateSchema, type InstanceMemoryLayout } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateMemoryAssessmentLayout } from "./service.js";

const MiB = 1024 * 1024;

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
    totalBytes: gpuBytes + hostBytes + 400 * MiB,
    context: {
      nCtx: 4096,
      nCtxSeq: 4096,
      nBatch: 512,
      nUbatch: 512,
      nSeqMax: 1,
      kvUnified: true,
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

test("exact llama.cpp buffers verify an estimate within tolerance", () => {
  const result = validateMemoryAssessmentLayout(
    estimate(4_000 * MiB, 1_000 * MiB),
    layout("log-buffers", 4_080 * MiB, 960 * MiB),
  );

  assert.equal(result?.verdict, "verified");
  assert.deepEqual(
    result?.deltas.map((entry) => entry.scope),
    ["gpu", "host"],
  );
});

test("exact llama.cpp buffers expose VRAM estimator drift", () => {
  const result = validateMemoryAssessmentLayout(
    estimate(4_000 * MiB, 1_000 * MiB),
    layout("log-buffers", 5_000 * MiB, 1_000 * MiB),
  );

  assert.equal(result?.verdict, "mismatch");
  const gpu = result?.deltas.find((entry) => entry.scope === "gpu");
  assert.ok(gpu);
  assert.ok(gpu.deltaBytes > gpu.toleranceBytes);
});

test("process telemetry is not treated as a buffer-level verification", () => {
  const result = validateMemoryAssessmentLayout(
    estimate(4_000 * MiB, 1_000 * MiB),
    layout("process-telemetry", 8_000 * MiB, 2_000 * MiB),
  );

  assert.equal(result, null);
});

test("unclassified llama.cpp buffers do not produce a false verification", () => {
  const unknown = layout("log-buffers", 4_000 * MiB, 1_000 * MiB);
  unknown.otherBytes = 256 * MiB;
  unknown.totalBytes += unknown.otherBytes;
  const result = validateMemoryAssessmentLayout(
    estimate(4_000 * MiB, 1_000 * MiB),
    unknown,
  );

  assert.equal(result?.verdict, "inconclusive");
});
