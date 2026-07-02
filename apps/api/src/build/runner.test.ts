import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import type { BuildJobStart, BuildSettings } from "@llama-manager/core";

import {
  buildSteps,
  buildProcessEnv,
  slugifyRef,
  validateBuildDirectoryCleanTarget,
} from "./runner.js";

function jobStart(overrides: Partial<BuildJobStart>): BuildJobStart {
  return {
    gitRef: null,
    pull: false,
    installUiDeps: false,
    cleanBuildDir: false,
    configure: false,
    build: false,
    ...overrides,
  };
}

function settings(env: Record<string, string>): BuildSettings {
  return {
    repoPath: "/tmp/llama.cpp",
    buildDir: "/tmp/llama.cpp/build-cuda",
    buildType: "Release",
    buildProfile: "server",
    cuda: true,
    rpc: false,
    native: false,
    cudaArchitectures: null,
    cudaFaAllQuants: false,
    cudaGraphs: "default",
    cudaNoVmm: false,
    llguidance: "default",
    extraCmakeArgs: [],
    env,
    target: "llama-server",
    parallelJobs: 1,
  };
}

test("buildProcessEnv discovers nvcc from CUDA_HOME", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-cuda-"));
  const binDir = join(dir, "bin");
  const nvcc = join(binDir, "nvcc");
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(nvcc, "");

    const env = buildProcessEnv(
      settings({
        CUDA_HOME: dir,
        PATH: "/usr/bin",
      }),
    );

    assert.equal(env.CUDACXX, nvcc);
    assert.equal(env.PATH?.split(delimiter)[0], binDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildProcessEnv preserves explicit CUDACXX", () => {
  const env = buildProcessEnv(
    settings({
      CUDACXX: "/custom/cuda/bin/nvcc",
      PATH: "/usr/bin",
    }),
  );

  assert.equal(env.CUDACXX, "/custom/cuda/bin/nvcc");
  assert.equal(env.PATH?.split(delimiter)[0], "/custom/cuda/bin");
});

test("validateBuildDirectoryCleanTarget rejects repository directory", () => {
  assert.throws(
    () =>
      validateBuildDirectoryCleanTarget({
        ...settings({}),
        repoPath: "/tmp/llama.cpp",
        buildDir: "/tmp/llama.cpp",
      }),
    /repository directory/,
  );
});

test("buildSteps applies server build profile CMake definitions", () => {
  const [configure] = buildSteps(
    { ...settings({}), cuda: false },
    jobStart({ configure: true }),
    {},
  );

  assert.equal(configure?.name, "configure");
  assert.ok(configure.command.includes("-DLLAMA_BUILD_COMMON=ON"));
  assert.ok(configure.command.includes("-DLLAMA_BUILD_TESTS=OFF"));
  assert.ok(configure.command.includes("-DLLAMA_BUILD_EXAMPLES=OFF"));
  assert.ok(configure.command.includes("-DLLAMA_BUILD_APP=OFF"));
  assert.ok(configure.command.includes("-DLLAMA_BUILD_TOOLS=ON"));
  assert.ok(configure.command.includes("-DLLAMA_BUILD_SERVER=ON"));
});

test("buildSteps configures GGML_RPC off by default and on when enabled", () => {
  const [off] = buildSteps(
    { ...settings({}), cuda: false },
    jobStart({ configure: true }),
    {},
  );
  assert.ok(off?.command.includes("-DGGML_RPC=OFF"));

  const [on] = buildSteps(
    { ...settings({}), cuda: false, rpc: true },
    jobStart({ configure: true }),
    {},
  );
  assert.ok(on?.command.includes("-DGGML_RPC=ON"));
});

test("buildSteps appends an rpc-server companion build when rpc is enabled", () => {
  const steps = buildSteps(
    { ...settings({}), rpc: true, target: "llama-server" },
    jobStart({ build: true }),
    {},
  );

  const companion = steps.find((item) => item.name === "build-rpc-server");
  assert.ok(companion);
  const targetIndex = companion.command.indexOf("--target");
  assert.equal(companion.command[targetIndex + 1], "ggml-rpc-server");
});

test("buildSteps omits the rpc-server companion when rpc is disabled", () => {
  const steps = buildSteps(
    { ...settings({}), rpc: false, target: "llama-server" },
    jobStart({ build: true }),
    {},
  );

  assert.ok(!steps.some((item) => item.name === "build-rpc-server"));
});

test("buildSteps does not duplicate the rpc-server companion when target is rpc-server", () => {
  const steps = buildSteps(
    { ...settings({}), rpc: true, target: "ggml-rpc-server" },
    jobStart({ build: true }),
    {},
  );

  assert.equal(
    steps.filter((item) => item.name === "build-rpc-server").length,
    0,
  );
});

test("buildSteps omits --target when target is empty", () => {
  const [build] = buildSteps(
    { ...settings({}), target: "" },
    jobStart({ build: true }),
    {},
  );

  assert.equal(build?.name, "build");
  assert.ok(!build.command.includes("--target"));
});

test("buildSteps passes --target when target is set", () => {
  const [build] = buildSteps(
    { ...settings({}), target: "llama-cli" },
    jobStart({ build: true }),
    {},
  );

  assert.equal(build?.name, "build");
  const targetIndex = build.command.indexOf("--target");
  assert.ok(targetIndex >= 0);
  assert.equal(build.command[targetIndex + 1], "llama-cli");
});

test("buildSteps appends a non-fatal llama-fit-params companion build", () => {
  const steps = buildSteps(
    { ...settings({}), target: "llama-server" },
    jobStart({ build: true }),
    {},
  );

  const companion = steps.find((item) => item.name === "build-fit-params");
  assert.ok(companion);
  const targetIndex = companion.command.indexOf("--target");
  assert.equal(companion.command[targetIndex + 1], "llama-fit-params");
  assert.equal(steps[steps.length - 1]?.name, "build-fit-params");
});

test("buildSteps does not duplicate the companion when target is llama-fit-params", () => {
  const steps = buildSteps(
    { ...settings({}), target: "llama-fit-params" },
    jobStart({ build: true }),
    {},
  );

  assert.equal(
    steps.filter((item) => item.name === "build-fit-params").length,
    0,
  );
});

test("buildSteps omits the companion build when build is disabled", () => {
  const steps = buildSteps(
    { ...settings({}) },
    jobStart({ configure: true }),
    {},
  );

  assert.ok(!steps.some((item) => item.name === "build-fit-params"));
});

test("buildSteps applies selected CUDA and optional CMake definitions", () => {
  const [configure] = buildSteps(
    {
      ...settings({}),
      cudaArchitectures: "86;89",
      cudaFaAllQuants: true,
      cudaGraphs: "off",
      cudaNoVmm: true,
      llguidance: "on",
    },
    jobStart({ configure: true }),
    {},
  );

  assert.equal(configure?.name, "configure");
  assert.ok(configure.command.includes("-DCMAKE_CUDA_ARCHITECTURES=86;89"));
  assert.ok(configure.command.includes("-DGGML_CUDA_FA_ALL_QUANTS=ON"));
  assert.ok(configure.command.includes("-DGGML_CUDA_GRAPHS=OFF"));
  assert.ok(configure.command.includes("-DGGML_CUDA_NO_VMM=ON"));
  assert.ok(configure.command.includes("-DLLAMA_LLGUIDANCE=ON"));
});

test("buildSteps lets explicit extra CMake args override managed definitions", () => {
  const [configure] = buildSteps(
    {
      ...settings({}),
      cudaArchitectures: "native",
      cudaGraphs: "on",
      extraCmakeArgs: [
        "-DCMAKE_CUDA_ARCHITECTURES=75",
        "-DGGML_CUDA_GRAPHS=OFF",
        "-DLLAMA_BUILD_TESTS=ON",
      ],
    },
    jobStart({ configure: true }),
    {},
  );

  assert.equal(configure?.name, "configure");
  assert.equal(
    configure.command.filter((item) =>
      item.startsWith("-DCMAKE_CUDA_ARCHITECTURES="),
    ).length,
    1,
  );
  assert.ok(configure.command.includes("-DCMAKE_CUDA_ARCHITECTURES=75"));
  assert.ok(configure.command.includes("-DGGML_CUDA_GRAPHS=OFF"));
  assert.ok(configure.command.includes("-DLLAMA_BUILD_TESTS=ON"));
  assert.equal(
    configure.command.filter((item) => item.startsWith("-DLLAMA_BUILD_TESTS="))
      .length,
    1,
  );
});

test("validateBuildDirectoryCleanTarget rejects a dir directly under root or home", () => {
  assert.throws(
    () =>
      validateBuildDirectoryCleanTarget({
        ...settings({}),
        repoPath: "/tmp/llama.cpp",
        buildDir: "/master",
      }),
    /directly under filesystem root or home/,
  );
});

test("validateBuildDirectoryCleanTarget accepts a per-branch build directory", () => {
  assert.equal(
    validateBuildDirectoryCleanTarget({
      ...settings({}),
      repoPath: "/tmp/llama.cpp",
      buildDir: "/tmp/builds/master",
    }),
    "/tmp/builds/master",
  );
});

test("buildSteps inserts git-checkout before git-pull when gitRef is set", () => {
  const steps = buildSteps(
    { ...settings({}), cuda: false },
    jobStart({ gitRef: "feature/foo", pull: true }),
    {},
  );

  assert.equal(steps[0]?.name, "git-checkout");
  assert.deepEqual(steps[0]?.command, ["git", "checkout", "feature/foo"]);
  assert.equal(steps[1]?.name, "git-pull");
});

test("buildSteps has no git-checkout step without gitRef", () => {
  const steps = buildSteps(
    { ...settings({}), cuda: false },
    jobStart({ pull: true }),
    {},
  );

  assert.ok(!steps.some((item) => item.name === "git-checkout"));
});

test("slugifyRef sanitizes ref names into safe directory segments", () => {
  assert.equal(slugifyRef("feature/foo"), "feature-foo");
  assert.equal(slugifyRef("master"), "master");
  assert.equal(slugifyRef("b1234"), "b1234");
  assert.equal(slugifyRef("///"), "build");
});
