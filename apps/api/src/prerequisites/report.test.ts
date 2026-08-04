import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  evaluatePrerequisite,
  prerequisiteDefinitionIsApplicable,
} from "./report.js";
import {
  findPrerequisiteDefinition,
  type PrerequisiteDefinition,
  type PrerequisiteProbeContext,
} from "./registry.js";
import { PrerequisiteRebootState } from "./reboot-state.js";

function context(
  overrides: Partial<PrerequisiteProbeContext> = {},
): PrerequisiteProbeContext {
  return {
    env: {},
    searchDirectories: [],
    usage: {
      cudaBuild: false,
      httpsFeatures: false,
      numaBind: false,
      numaInterleave: false,
      pythonEngines: false,
    },
    nvidiaPci: {
      state: "absent",
      devices: [],
      detail: "No NVIDIA GPU",
    },
    amdPci: {
      state: "absent",
      devices: [],
      detail: "No AMD GPU",
    },
    rocmDeviceAvailable: false,
    nvidiaTelemetryStatus: () => ({
      state: "no-library",
      detail: "NVML unavailable",
      driverVersion: null,
      deviceCount: 0,
    }),
    ...overrides,
  };
}

test("keeps runnable setup separate from manual follow-up commands", async () => {
  const definition: PrerequisiteDefinition = {
    id: "test-tool",
    group: "build",
    title: "Test tool",
    kind: "executable",
    severity: "recommended",
    blocks: [],
    impact: "",
    packages: {},
    commands: ["sudo reboot"],
    installCommands: ["sudo first-step", "sudo second-step"],
    includeInInstallPlan: false,
    docPath: null,
    note: null,
    probe: async () => ({
      status: "missing",
      detail: null,
      version: null,
    }),
  };

  const check = await evaluatePrerequisite(definition, context());

  assert.equal(
    check.remediation.installCommand,
    "sudo first-step && sudo second-step",
  );
  assert.deepEqual(check.remediation.commands, ["sudo reboot"]);
  assert.equal(check.remediation.includeInInstallPlan, false);
  assert.equal(check.remediation.rebootRequired, false);
});

test("hides NVIDIA prerequisites on a CPU-only host", () => {
  const driver = findPrerequisiteDefinition("nvidia-driver");
  const nvcc = findPrerequisiteDefinition("nvcc");
  assert.ok(driver);
  assert.ok(nvcc);
  const cpu = context();
  assert.equal(prerequisiteDefinitionIsApplicable(driver, cpu), false);
  assert.equal(prerequisiteDefinitionIsApplicable(nvcc, cpu), false);
});

test("keeps CUDA build prerequisites even without a local GPU", () => {
  const nvcc = findPrerequisiteDefinition("nvcc");
  assert.ok(nvcc);
  const cudaBuild = context({
    usage: {
      ...context().usage,
      cudaBuild: true,
    },
  });
  assert.equal(prerequisiteDefinitionIsApplicable(nvcc, cudaBuild), true);
});

test("shows NVIDIA prerequisites when NVML exposes a container GPU", () => {
  const driver = findPrerequisiteDefinition("nvidia-driver");
  const nvidiaSmi = findPrerequisiteDefinition("nvidia-smi");
  assert.ok(driver);
  assert.ok(nvidiaSmi);
  const nvml = context({
    nvidiaPci: {
      state: "unknown",
      devices: [],
      detail: "PCI sysfs is unavailable",
    },
    nvidiaTelemetryStatus: () => ({
      state: "ready",
      detail: "1 NVIDIA GPU available through NVML",
      driverVersion: "595.71.05",
      deviceCount: 1,
    }),
  });
  assert.equal(prerequisiteDefinitionIsApplicable(driver, nvml), true);
  assert.equal(prerequisiteDefinitionIsApplicable(nvidiaSmi, nvml), true);
  assert.equal(prerequisiteDefinitionIsApplicable(nvidiaSmi, context()), false);
});

test("hides the ROCm device check on hosts without AMD display hardware", () => {
  const rocm = findPrerequisiteDefinition("rocm-kfd");
  assert.ok(rocm);
  assert.equal(prerequisiteDefinitionIsApplicable(rocm, context()), false);
  const amdGpu = context({
    amdPci: {
      state: "present",
      devices: [
        {
          address: "0000:03:00.0",
          deviceId: "0x744c",
          classCode: "0x030000",
          driver: null,
        },
      ],
      detail: "1 AMD display controller detected through PCI",
    },
  });
  assert.equal(prerequisiteDefinitionIsApplicable(rocm, amdGpu), true);
  const kfdWithoutPci = context({
    amdPci: {
      state: "unknown",
      devices: [],
      detail: "PCI sysfs is unavailable",
    },
    rocmDeviceAvailable: true,
  });
  assert.equal(prerequisiteDefinitionIsApplicable(rocm, kfdWithoutPci), true);
});

test("keeps a successful install local-only and pending across manager restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-report-reboot-"));
  const state = new PrerequisiteRebootState(
    join(directory, "state.json"),
    () => "boot-a",
  );
  const definition: PrerequisiteDefinition = {
    id: "nvidia-driver",
    group: "cuda",
    title: "NVIDIA driver (NVML)",
    kind: "capability",
    severity: "required",
    blocks: ["NVIDIA GPU use"],
    impact: "",
    packages: {},
    commands: ["sudo reboot"],
    installCommands: ["sudo install-driver"],
    includeInInstallPlan: false,
    requiresRebootAfterInstall: true,
    applies: () => false,
    docPath: null,
    note: null,
    probe: async () => ({
      status: "missing",
      detail: "driver not loaded",
      version: null,
      remediationAvailable: true,
    }),
  };
  try {
    state.markPending(definition.id);
    assert.equal(
      prerequisiteDefinitionIsApplicable(definition, context(), state),
      true,
    );
    const check = await evaluatePrerequisite(definition, context(), state);
    assert.equal(check.remediation.installCommand, "sudo install-driver");
    assert.deepEqual(check.remediation.commands, ["sudo reboot"]);
    assert.equal(check.remediation.includeInInstallPlan, false);
    assert.equal(check.remediation.rebootRequired, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
