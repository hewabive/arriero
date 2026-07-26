import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrerequisiteCheck } from "@llama-manager/core";

import { buildInstallPlan, summarizeChecks } from "./install-plan.js";

function check(overrides: Partial<PrerequisiteCheck>): PrerequisiteCheck {
  return {
    id: "cmake",
    title: "CMake",
    kind: "executable",
    severity: "required",
    status: "missing",
    blocks: [],
    impact: "",
    detail: null,
    version: null,
    remediation: {
      packages: ["cmake"],
      installCommand: "sudo apt install -y cmake",
      commands: [],
      docPath: null,
      note: null,
    },
    ...overrides,
  };
}

test("aggregates missing packages into one command and dedupes", () => {
  const plan = buildInstallPlan(
    [
      check({ id: "cmake", remediation: { ...check({}).remediation } }),
      check({
        id: "make",
        remediation: {
          packages: ["build-essential"],
          installCommand: null,
          commands: [],
          docPath: null,
          note: null,
        },
      }),
      check({
        id: "cxx",
        remediation: {
          packages: ["build-essential"],
          installCommand: null,
          commands: [],
          docPath: null,
          note: null,
        },
      }),
    ],
    "apt",
  );

  assert.equal(
    plan.requiredCommand,
    "sudo apt install -y cmake build-essential",
  );
});

test("required command excludes recommended packages", () => {
  const checks = [
    check({ id: "cmake" }),
    check({
      id: "ccache",
      severity: "recommended",
      remediation: {
        packages: ["ccache"],
        installCommand: null,
        commands: [],
        docPath: null,
        note: null,
      },
    }),
  ];

  const plan = buildInstallPlan(checks, "apt");
  assert.equal(plan.requiredCommand, "sudo apt install -y cmake");
  assert.equal(plan.allCommand, "sudo apt install -y cmake ccache");
});

test("present and out-of-path checks never enter the install plan", () => {
  const plan = buildInstallPlan(
    [check({ status: "ok" }), check({ id: "git", status: "out-of-path" })],
    "apt",
  );
  assert.equal(plan.requiredCommand, null);
  assert.equal(plan.allCommand, null);
});

test("unverifiable checks still contribute packages so one command suffices", () => {
  const plan = buildInstallPlan(
    [
      check({
        id: "libcurl-dev",
        status: "unknown",
        remediation: {
          packages: ["libcurl4-openssl-dev"],
          installCommand: null,
          commands: [],
          docPath: null,
          note: null,
        },
      }),
    ],
    "apt",
  );
  assert.equal(
    plan.requiredCommand,
    "sudo apt install -y libcurl4-openssl-dev",
  );
});

test("unknown package manager yields no command", () => {
  const plan = buildInstallPlan([check({})], "unknown");
  assert.equal(plan.requiredCommand, null);
  assert.equal(plan.packageManager, "unknown");
});

test("summary separates severities and non-missing states", () => {
  const summary = summarizeChecks([
    check({ status: "ok" }),
    check({ status: "ok" }),
    check({ status: "missing", severity: "required" }),
    check({ status: "missing", severity: "recommended" }),
    check({ status: "out-of-path" }),
    check({ status: "unknown" }),
  ]);

  assert.deepEqual(summary, {
    ok: 2,
    missingRequired: 1,
    missingRecommended: 1,
    outOfPath: 1,
    unknown: 1,
  });
});
