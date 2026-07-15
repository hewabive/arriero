import type { SystemAccelerator } from "@llama-manager/core";
import assert from "node:assert/strict";
import test from "node:test";

import { environmentAvailability } from "./availability.js";

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
  numaNode: null,
  source: "nvidia-smi",
};

test("CPU environments are usable without an accelerator", () => {
  assert.deepEqual(
    environmentAvailability({ accelerators: [], installed: true, variant: "cpu" }),
    { availability: "usable", availabilityReason: null },
  );
});

test("CUDA environments distinguish installed from usable", () => {
  assert.equal(
    environmentAvailability({ accelerators: [], installed: true, variant: "cuda" })
      .availability,
    "unavailable",
  );
  assert.equal(
    environmentAvailability({ accelerators: [nvidia], installed: true, variant: "cuda" })
      .availability,
    "usable",
  );
});

test("ROCm availability requires /dev/kfd and missing installs stay separate", () => {
  assert.equal(
    environmentAvailability({
      accelerators: [],
      installed: true,
      rocmDeviceAvailable: false,
      variant: "rocm",
    }).availability,
    "unavailable",
  );
  assert.equal(
    environmentAvailability({ accelerators: [], installed: false, variant: "cpu" })
      .availability,
    "not-installed",
  );
});
