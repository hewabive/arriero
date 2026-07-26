import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildJobStep, BuildJobStepName } from "@llama-manager/core";

import {
  buildPrerequisiteIds,
  formatBuildPrerequisiteError,
} from "./preflight.js";

function step(name: BuildJobStepName, command: string[]): BuildJobStep {
  return {
    name,
    command,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };
}

test("derives prerequisites from the planned step commands", () => {
  const ids = buildPrerequisiteIds(
    [
      step("git-pull", ["git", "pull", "--ff-only"]),
      step("ui-install", ["npm", "ci", "&&", "npm", "run", "build"]),
      step("configure", ["cmake", "-S", "/src", "-B", "/build"]),
      step("build", ["cmake", "--build", "/build"]),
    ],
    { cuda: false },
  );

  assert.deepEqual(ids, [
    "git",
    "node",
    "npm",
    "cmake",
    "cxx-toolchain",
    "make",
    "pkg-config",
    "libcurl-dev",
  ]);
});

test("skips the internal clean-build-dir pseudo command", () => {
  const ids = buildPrerequisiteIds(
    [step("clean-build-dir", ["clean-build-dir", "/build"])],
    { cuda: false },
  );
  assert.deepEqual(ids, []);
});

test("a build without a configure step needs no compiler toolchain", () => {
  const ids = buildPrerequisiteIds(
    [step("build", ["cmake", "--build", "/build"])],
    { cuda: false },
  );
  assert.deepEqual(ids, ["cmake"]);
});

test("cuda builds additionally require nvcc", () => {
  const ids = buildPrerequisiteIds(
    [step("configure", ["cmake", "-S", "/src"])],
    { cuda: true },
  );
  assert.ok(ids.includes("nvcc"));
});

test("error message names every missing tool and its packages", () => {
  const message = formatBuildPrerequisiteError(
    [
      {
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
          installCommand: null,
          commands: [],
          docPath: null,
          note: null,
        },
      },
    ],
    "sudo apt install -y cmake",
  );

  assert.equal(
    message,
    "missing build prerequisites: CMake (cmake). Install with: sudo apt install -y cmake",
  );
});
