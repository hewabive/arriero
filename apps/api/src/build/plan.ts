import type {
  BuildJob,
  BuildJobStart,
  BuildJobStep,
  BuildJobStepName,
  BuildSettings,
} from "@arriero/core";
import { existsSync, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { delimiter, dirname, parse, resolve } from "node:path";
import { availableParallelism, homedir } from "node:os";

import { config } from "../config.js";
import { isPathWithin } from "../path-utils.js";
import {
  getLlamaSourceCurrentCommit,
  listLlamaSourceRefs,
} from "../llama/source-repository.js";
import { findExecutableInPath } from "../system/tool-probe.js";
import {
  cmakeCacheGeneratorState,
  relocatedCmakeCacheReason,
} from "./cmake-cache.js";
import { findNvcc } from "./cuda.js";

const FIT_PARAMS_TARGET = "llama-fit-params";
const RPC_SERVER_TARGET = "ggml-rpc-server";

export function fitParamsSourceDir(settings: BuildSettings) {
  return resolve(settings.repoPath, "tools", "fit-params");
}

export function rpcSourceDir(settings: BuildSettings) {
  return resolve(settings.repoPath, "tools", "rpc");
}

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

export function uiDirectory(settings: BuildSettings) {
  return resolve(settings.repoPath, "tools", "ui");
}

export function slugifyRef(ref: string): string {
  const slug = ref
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "build";
}

export function resolveBuildRef(gitRef: string | null): string {
  if (gitRef) {
    return gitRef;
  }
  const currentBranch = listLlamaSourceRefs().currentBranch;
  if (currentBranch) {
    return currentBranch;
  }
  const commit = getLlamaSourceCurrentCommit();
  return commit ? `commit-${commit.slice(0, 12)}` : "build";
}

function prependPathEntry(pathValue: string | undefined, entry: string) {
  const current = pathValue?.split(delimiter).filter(Boolean) ?? [];
  if (current.includes(entry)) {
    return current.join(delimiter);
  }
  return [entry, ...current].join(delimiter);
}

function hasCmakeDefinition(args: string[], name: string) {
  return args.some(
    (arg) =>
      arg === `-D${name}` ||
      arg.startsWith(`-D${name}=`) ||
      arg.startsWith(`-D${name}:`),
  );
}

function cmakeDefinitionIfMissing(args: string[], name: string, value: string) {
  return hasCmakeDefinition(args, name) ? [] : [`-D${name}=${value}`];
}

function cmakeBooleanModeDefinition(
  args: string[],
  name: string,
  mode: "default" | "on" | "off",
) {
  if (mode === "default") {
    return [];
  }
  return cmakeDefinitionIfMissing(args, name, mode === "on" ? "ON" : "OFF");
}

export function cmakeGeneratorFromCommand(command: string[]): string | null {
  for (const [index, argument] of command.entries()) {
    if (argument === "-G") {
      return command[index + 1] ?? "";
    }
    if (argument.startsWith("-G")) {
      return argument.slice(2);
    }
  }
  return null;
}

function hasExplicitGenerator(args: string[], env: NodeJS.ProcessEnv) {
  return (
    cmakeGeneratorFromCommand(args) !== null ||
    hasCmakeDefinition(args, "CMAKE_GENERATOR") ||
    Boolean(env.CMAKE_GENERATOR)
  );
}

function autoNinjaGeneratorArguments(
  settings: BuildSettings,
  input: BuildJobStart,
  env: NodeJS.ProcessEnv,
): string[] {
  if (hasExplicitGenerator(settings.extraCmakeArgs, env)) {
    return [];
  }
  if (!findExecutableInPath("ninja", env.PATH)) {
    return [];
  }
  if (!input.cleanBuildDir) {
    const cache = cmakeCacheGeneratorState(settings.buildDir);
    if (cache.exists && cache.generator !== "Ninja") {
      return [];
    }
  }
  return ["-G", "Ninja"];
}

function parallelJobsArguments(settings: BuildSettings) {
  return ["-j", String(settings.parallelJobs ?? availableParallelism())];
}

function serverBuildProfileDefinitions(args: string[]) {
  return [
    ...cmakeDefinitionIfMissing(args, "LLAMA_BUILD_COMMON", "ON"),
    ...cmakeDefinitionIfMissing(args, "LLAMA_BUILD_TESTS", "OFF"),
    ...cmakeDefinitionIfMissing(args, "LLAMA_BUILD_EXAMPLES", "OFF"),
    ...cmakeDefinitionIfMissing(args, "LLAMA_BUILD_APP", "OFF"),
    ...cmakeDefinitionIfMissing(args, "LLAMA_BUILD_TOOLS", "ON"),
    ...cmakeDefinitionIfMissing(args, "LLAMA_BUILD_SERVER", "ON"),
  ];
}

export function buildProcessEnv(settings: BuildSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...settings.env };

  if (!settings.cuda) {
    return env;
  }

  const nvcc = findNvcc(env);
  if (!nvcc) {
    return env;
  }

  if (!env.CUDACXX) {
    env.CUDACXX = nvcc;
  }
  env.PATH = prependPathEntry(env.PATH, dirname(nvcc));
  return env;
}

export function buildSteps(
  settings: BuildSettings,
  input: BuildJobStart,
  env: NodeJS.ProcessEnv,
): BuildJobStep[] {
  const steps: BuildJobStep[] = [];

  if (input.gitRef) {
    steps.push(step("git-checkout", ["git", "checkout", input.gitRef]));
  }

  if (input.pull) {
    steps.push(step("git-pull", ["git", "pull", "--ff-only"]));
  }

  if (input.installUiDeps) {
    steps.push(
      step("ui-install", [
        "npm",
        "ci",
        "--include=dev",
        "&&",
        "npm",
        "run",
        "build",
      ]),
    );
  }

  if (input.cleanBuildDir) {
    steps.push(step("clean-build-dir", ["clean-build-dir", settings.buildDir]));
  }

  if (input.configure) {
    const cudaCompiler = settings.cuda ? findNvcc(env) : null;
    steps.push(
      step("configure", [
        "cmake",
        "-S",
        settings.repoPath,
        "-B",
        settings.buildDir,
        ...autoNinjaGeneratorArguments(settings, input, env),
        `-DCMAKE_BUILD_TYPE=${settings.buildType}`,
        `-DGGML_CUDA=${settings.cuda ? "ON" : "OFF"}`,
        `-DGGML_RPC=${settings.rpc ? "ON" : "OFF"}`,
        `-DGGML_NATIVE=${settings.native ? "ON" : "OFF"}`,
        ...(settings.buildProfile === "server"
          ? serverBuildProfileDefinitions(settings.extraCmakeArgs)
          : []),
        ...(settings.cuda && settings.cudaArchitectures
          ? cmakeDefinitionIfMissing(
              settings.extraCmakeArgs,
              "CMAKE_CUDA_ARCHITECTURES",
              settings.cudaArchitectures,
            )
          : []),
        ...(settings.cuda && settings.cudaFaAllQuants
          ? cmakeDefinitionIfMissing(
              settings.extraCmakeArgs,
              "GGML_CUDA_FA_ALL_QUANTS",
              "ON",
            )
          : []),
        ...(settings.cuda
          ? cmakeBooleanModeDefinition(
              settings.extraCmakeArgs,
              "GGML_CUDA_GRAPHS",
              settings.cudaGraphs,
            )
          : []),
        ...(settings.cuda && settings.cudaNoVmm
          ? cmakeDefinitionIfMissing(
              settings.extraCmakeArgs,
              "GGML_CUDA_NO_VMM",
              "ON",
            )
          : []),
        ...cmakeBooleanModeDefinition(
          settings.extraCmakeArgs,
          "LLAMA_LLGUIDANCE",
          settings.llguidance,
        ),
        ...(cudaCompiler &&
        !hasCmakeDefinition(settings.extraCmakeArgs, "CMAKE_CUDA_COMPILER")
          ? [`-DCMAKE_CUDA_COMPILER=${cudaCompiler}`]
          : []),
        ...cmakeDefinitionIfMissing(
          settings.extraCmakeArgs,
          "LLAMA_BUILD_UI",
          input.installUiDeps ? "ON" : "OFF",
        ),
        ...cmakeDefinitionIfMissing(
          settings.extraCmakeArgs,
          "LLAMA_USE_PREBUILT_UI",
          "OFF",
        ),
        ...settings.extraCmakeArgs,
      ]),
    );
  }

  if (input.build) {
    const command = [
      "cmake",
      "--build",
      settings.buildDir,
      "--config",
      settings.buildType,
    ];
    const target = settings.target.trim();
    if (target) {
      command.push("--target", target);
    }
    command.push(...parallelJobsArguments(settings));
    steps.push(step("build", command));

    if (target !== FIT_PARAMS_TARGET) {
      steps.push(
        step("build-fit-params", [
          "cmake",
          "--build",
          settings.buildDir,
          "--config",
          settings.buildType,
          "--target",
          FIT_PARAMS_TARGET,
          ...parallelJobsArguments(settings),
        ]),
      );
    }

    if (settings.rpc && target !== RPC_SERVER_TARGET) {
      steps.push(
        step("build-rpc-server", [
          "cmake",
          "--build",
          settings.buildDir,
          "--config",
          settings.buildType,
          "--target",
          RPC_SERVER_TARGET,
          ...parallelJobsArguments(settings),
        ]),
      );
    }
  }

  return steps;
}

export function commandCwd(
  settings: BuildSettings,
  stepName: BuildJobStepName,
) {
  if (stepName === "git-checkout" || stepName === "git-pull") {
    return settings.repoPath;
  }
  if (stepName === "ui-install") {
    return uiDirectory(settings);
  }
  return config.rootDir;
}

export function validateBuildDirectoryCleanTarget(settings: BuildSettings) {
  const buildDir = resolve(settings.buildDir);
  const repoPath = resolve(settings.repoPath);
  const parentOfRepo = dirname(repoPath);
  const root = parse(buildDir).root;
  const home = homedir();
  const parent = dirname(buildDir);

  if (buildDir === root) {
    throw new Error("refusing to clean filesystem root as build directory");
  }
  if (buildDir === home) {
    throw new Error("refusing to clean user home as build directory");
  }
  if (buildDir === repoPath) {
    throw new Error("refusing to clean llama.cpp repository directory");
  }
  if (buildDir === parentOfRepo || isPathWithin(buildDir, repoPath)) {
    throw new Error("refusing to clean a parent directory of llama.cpp");
  }
  if (parent === root || parent === home) {
    throw new Error(
      "refusing to clean a build directory placed directly under filesystem root or home",
    );
  }

  return buildDir;
}

export function cleanBuildDirectory(
  settings: BuildSettings,
  logStream: WriteStream,
) {
  const buildDir = validateBuildDirectoryCleanTarget(settings);
  if (existsSync(buildDir)) {
    logStream.write(`# removing build directory ${buildDir}\n`);
    rmSync(buildDir, { recursive: true, force: true });
  } else {
    logStream.write(`# build directory does not exist: ${buildDir}\n`);
  }
  mkdirSync(buildDir, { recursive: true });
}

export function validateSettings(
  settings: BuildSettings,
  steps: BuildJobStep[],
) {
  if (!existsSync(resolve(settings.repoPath, "CMakeLists.txt"))) {
    throw new Error(`CMakeLists.txt not found in ${settings.repoPath}`);
  }

  if (
    steps.some(
      (item) => item.name === "git-pull" || item.name === "git-checkout",
    ) &&
    !existsSync(resolve(settings.repoPath, ".git"))
  ) {
    throw new Error(`Git repository not found in ${settings.repoPath}`);
  }

  if (
    steps.some((item) => item.name === "ui-install") &&
    !existsSync(resolve(uiDirectory(settings), "package.json"))
  ) {
    throw new Error(`tools/ui/package.json not found in ${settings.repoPath}`);
  }

  const cleanBuildDir = steps.some((item) => item.name === "clean-build-dir");
  if (cleanBuildDir) {
    validateBuildDirectoryCleanTarget(settings);
  }

  if (!cleanBuildDir) {
    mkdirSync(settings.buildDir, { recursive: true });
  }

  const reconfigures =
    cleanBuildDir || steps.some((item) => item.name === "configure");
  if (!reconfigures && steps.some((item) => item.name === "build")) {
    const relocated = relocatedCmakeCacheReason(
      settings.buildDir,
      settings.repoPath,
    );
    if (relocated) {
      throw new Error(
        `${relocated}; enable Configure to regenerate the build tree`,
      );
    }
  }
}

function binaryCandidateName(target: string) {
  if (process.platform !== "win32" || target.endsWith(".exe")) {
    return target;
  }
  return `${target}.exe`;
}

function detectTargetBinaryPath(settings: BuildSettings, target: string) {
  const name = binaryCandidateName(target);
  const candidates = [
    resolve(settings.buildDir, "bin", name),
    resolve(settings.buildDir, "bin", settings.buildType, name),
    resolve(settings.buildDir, settings.buildType, name),
    resolve(settings.buildDir, name),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function detectBinaryPath(settings: BuildSettings) {
  return detectTargetBinaryPath(
    settings,
    settings.target.trim() || "llama-server",
  );
}

export function detectRpcServerBinaryPath(settings: BuildSettings) {
  return detectTargetBinaryPath(settings, RPC_SERVER_TARGET);
}

export function writeHeader(
  stream: WriteStream,
  job: BuildJob,
  env: NodeJS.ProcessEnv,
) {
  stream.write(`# arriero build job ${job.id}\n`);
  stream.write(`# started ${job.startedAt}\n`);
  stream.write(`# repo ${job.settings.repoPath}\n`);
  stream.write(`# build ${job.settings.buildDir}\n`);
  if (job.settings.cuda) {
    stream.write(`# CUDA compiler ${env.CUDACXX ?? "not detected"}\n`);
  }
  const configureStep = job.steps.find((item) => item.name === "configure");
  const generator = configureStep
    ? cmakeGeneratorFromCommand(configureStep.command)
    : null;
  if (generator) {
    stream.write(`# CMake generator ${generator}\n`);
  }
  if (job.settings.rpc) {
    stream.write(
      `# RPC backend ON (rpc-server worker built for multi-machine offload)\n`,
    );
  }
  const envKeys = Object.keys(job.settings.env).sort();
  if (envKeys.length > 0) {
    stream.write(`# build env overrides ${envKeys.join(", ")}\n`);
  }
  stream.write("\n");
}
