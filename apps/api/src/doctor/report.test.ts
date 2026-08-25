import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { config } from "../config.js";
import { resetAllConfigStores } from "../config-store/registry.js";
import {
  ENVIRONMENTS_FILE,
  ENVIRONMENTS_STATE_FILE,
  createEnvironmentSpec,
  deleteEnvironmentSpec,
} from "../envs/repository.js";
import {
  MODEL_REQUIREMENTS_FILE,
  upsertModelRequirement,
} from "../hf/requirements.js";
import { writeInstanceRecord } from "../instances/config-files.js";
import {
  createApiProxySource,
  deleteApiProxySource,
} from "../proxy/sources.js";
import { updateApiProxySettings } from "../proxy/settings.js";
import {
  RESOURCES_FILE,
  resetResourcePoolsCache,
} from "../resources/repository.js";
import { doctorResourcePoolFindings, getConfigDoctorReport } from "./report.js";

function findings(
  report: Awaited<ReturnType<typeof getConfigDoctorReport>>,
  checkId: string,
) {
  return report.checks.find((check) => check.id === checkId)?.findings ?? [];
}

test("doctor reports what this host cannot satisfy", async (t) => {
  const instanceFile = resolve(config.instancesDir, "doctor-broken.json");
  const inlineFile = resolve(config.instancesDir, "doctor-inline.json");
  const spec = createEnvironmentSpec({
    engine: "vllm",
    version: "0.24.0",
    variant: "cuda",
    pythonVersion: "3.12",
    source: { kind: "pypi", extras: [] },
  });
  upsertModelRequirement({
    repoId: "unsloth/doctor-demo",
    revision: "main",
    paths: ["model.gguf"],
    destDir: null,
  });
  const source = createApiProxySource({
    name: "doctor-source",
    enabled: true,
    note: "",
    blockedMessage: "",
  });
  updateApiProxySettings({ allowAnonymous: false });
  writeInstanceRecord({
    name: "doctor-broken",
    kind: "llama-server",
    binaryPath: "/nonexistent/bin/llama-server",
    args: { "--model": "/nonexistent/model.gguf" },
    env: {},
    memory: [],
    rpcWorkers: [],
  });
  writeInstanceRecord({
    name: "doctor-inline",
    kind: "llama-server",
    binaryPath: "/bin/sh",
    binaryPathRefId: "dangling-catalog-id",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
  });
  t.after(() => {
    updateApiProxySettings({ allowAnonymous: true });
    deleteApiProxySource(source.id);
    deleteEnvironmentSpec(spec.id);
    rmSync(instanceFile, { force: true });
    rmSync(inlineFile, { force: true });
    rmSync(MODEL_REQUIREMENTS_FILE, { force: true });
    rmSync(ENVIRONMENTS_FILE, { force: true });
    rmSync(ENVIRONMENTS_STATE_FILE, { force: true });
    resetAllConfigStores();
  });

  const report = await getConfigDoctorReport();

  const binaries = findings(report, "instance-binaries");
  assert.ok(
    binaries.some(
      (finding) =>
        finding.severity === "error" &&
        finding.summary.startsWith("doctor-broken"),
    ),
  );
  assert.ok(
    binaries.some(
      (finding) =>
        finding.severity === "info" &&
        finding.summary.startsWith("doctor-inline"),
    ),
  );
  assert.ok(
    findings(report, "environments").some(
      (finding) =>
        finding.severity === "warning" &&
        finding.summary.includes("vllm 0.24.0"),
    ),
  );
  assert.ok(
    findings(report, "model-requirements").some((finding) =>
      finding.summary.includes("unsloth/doctor-demo"),
    ),
  );
  assert.ok(
    findings(report, "instance-model-paths").some(
      (finding) => finding.detail === "/nonexistent/model.gguf",
    ),
  );
  const credentials = findings(report, "proxy-credentials");
  assert.ok(
    credentials.some(
      (finding) =>
        finding.severity === "warning" &&
        finding.summary.includes("doctor-source"),
    ),
  );
  assert.ok(
    credentials.some(
      (finding) =>
        finding.severity === "error" &&
        finding.summary.includes("anonymous access is off"),
    ),
  );
  assert.ok(report.summary.errors >= 2);
  assert.ok(report.summary.warnings >= 2);
});

test("orphaned pools with draws are warnings, without draws info", (t) => {
  writeFileSync(
    RESOURCES_FILE,
    `${JSON.stringify([
      {
        id: "gpu9",
        name: "Gone GPU",
        kind: "gpu",
        capacityBytes: null,
        reservedBytes: 0,
        deviceRef: "9",
        autoCapacity: true,
      },
    ])}\n`,
    "utf8",
  );
  resetResourcePoolsCache();
  const drawFile = resolve(config.instancesDir, "doctor-draw.json");
  writeInstanceRecord({
    name: "doctor-draw",
    kind: "llama-server",
    binaryPath: "/bin/sh",
    args: {},
    env: {},
    memory: [{ poolId: "gpu9", bytes: 1024 }],
    rpcWorkers: [],
  });
  t.after(() => {
    rmSync(drawFile, { force: true });
    rmSync(RESOURCES_FILE, { force: true });
    resetAllConfigStores();
  });

  const inventory = { authoritative: true, deviceRefs: new Set<string>() };
  const withDraw = doctorResourcePoolFindings(inventory);
  assert.equal(withDraw[0]?.severity, "warning");
  assert.ok(withDraw[0]?.summary.includes("doctor-draw"));

  rmSync(drawFile, { force: true });
  resetAllConfigStores();
  const withoutDraw = doctorResourcePoolFindings(inventory);
  assert.equal(withoutDraw[0]?.severity, "info");
});
