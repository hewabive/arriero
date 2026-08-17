import type { SystemAccelerator } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { environmentAvailability } from "./availability.js";
import { environmentProvisioner } from "./provisioners.js";
import { EnvironmentSpecSchema } from "@arriero/core";

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
  computeCapability: null,
  source: "nvml",
};

const pascal: SystemAccelerator = {
  ...nvidia,
  name: "NVIDIA GeForce GTX 1080 Ti",
  computeCapability: { major: 6, minor: 1 },
};

const ampere: SystemAccelerator = {
  ...nvidia,
  id: "1",
  name: "NVIDIA RTX A6000",
  computeCapability: { major: 8, minor: 6 },
};

test("CPU environments are usable without an accelerator", () => {
  assert.deepEqual(
    environmentAvailability({
      accelerators: [],
      installed: true,
      variant: "cpu",
    }),
    { availability: "usable", availabilityReason: null },
  );
});

test("CUDA environments distinguish installed from usable", () => {
  assert.equal(
    environmentAvailability({
      accelerators: [],
      installed: true,
      variant: "cuda",
    }).availability,
    "unavailable",
  );
  assert.equal(
    environmentAvailability({
      accelerators: [nvidia],
      installed: true,
      variant: "cuda",
    }).availability,
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
    environmentAvailability({
      accelerators: [],
      installed: false,
      variant: "cpu",
    }).availability,
    "not-installed",
  );
});

const ktSpec = EnvironmentSpecSchema.parse({
  engine: "ktransformers",
  version: "0.6.3.post1",
  pythonVersion: "3.12",
  id: "kt-availability",
  pathCatalogEntryId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const vllmCudaRequirement = {
  engineLabel: "vLLM",
  minimumComputeCapability: { major: 7, minor: 5 },
};

test("CUDA availability reports a compute-capability shortfall", () => {
  const shortfall = environmentAvailability({
    accelerators: [pascal],
    installed: true,
    variant: "cuda",
    cuda: vllmCudaRequirement,
  });
  assert.equal(shortfall.availability, "unavailable");
  assert.match(shortfall.availabilityReason ?? "", /compute capability 7\.5/);
  assert.match(shortfall.availabilityReason ?? "", /GTX 1080 Ti reports 6\.1/);

  assert.equal(
    environmentAvailability({
      accelerators: [pascal, ampere],
      installed: true,
      variant: "cuda",
      cuda: vllmCudaRequirement,
    }).availability,
    "usable",
  );
  assert.equal(
    environmentAvailability({
      accelerators: [nvidia],
      installed: true,
      variant: "cuda",
      cuda: vllmCudaRequirement,
    }).availability,
    "usable",
  );
});

test("CUDA hardware incompatibility is reported before installation", () => {
  assert.equal(
    environmentAvailability({
      accelerators: [],
      installed: false,
      variant: "cuda",
      cuda: vllmCudaRequirement,
    }).availability,
    "unavailable",
  );
  assert.equal(
    environmentAvailability({
      accelerators: [pascal],
      installed: false,
      variant: "cuda",
      cuda: vllmCudaRequirement,
    }).availability,
    "unavailable",
  );
  assert.equal(
    environmentAvailability({
      accelerators: [ampere],
      installed: false,
      variant: "cuda",
      cuda: vllmCudaRequirement,
    }).availability,
    "not-installed",
  );
});

test("KTransformers availability requires Linux x64 and NVIDIA", () => {
  const provisioner = environmentProvisioner("ktransformers");
  assert.equal(
    provisioner.availability(ktSpec, {
      accelerators: [nvidia],
      installed: true,
      rocmDeviceAvailable: false,
      platform: "linux",
      arch: "x64",
    }).availability,
    "usable",
  );
  assert.match(
    provisioner.availability(ktSpec, {
      accelerators: [nvidia],
      installed: true,
      rocmDeviceAvailable: false,
      platform: "darwin",
      arch: "arm64",
    }).availabilityReason ?? "",
    /Linux x86-64/,
  );
  assert.match(
    provisioner.availability(ktSpec, {
      accelerators: [],
      installed: true,
      rocmDeviceAvailable: false,
      platform: "linux",
      arch: "x64",
    }).availabilityReason ?? "",
    /NVIDIA/,
  );
  assert.match(
    provisioner.availability(ktSpec, {
      accelerators: [pascal],
      installed: false,
      rocmDeviceAvailable: false,
      platform: "linux",
      arch: "x64",
    }).availabilityReason ?? "",
    /KTransformers requires CUDA compute capability 7\.5/,
  );
});
