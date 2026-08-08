import {
  engineDescriptor,
  type EngineAssessmentFingerprintId,
  type InstanceKind,
  type InstanceMemoryLayout,
  type MemoryEstimateArgs,
} from "@arriero/core";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { defaultBinaryPath } from "../arguments/binary-discovery.js";
import {
  auxiliaryGgufPaths,
  poolsForEstimate,
  resolveLlamaArgumentEnvironment,
  resolveModelPath,
  DRAFT_MODEL_ARG_KEYS,
  MMPROJ_ARG_KEYS,
  type MemoryEstimateContext,
} from "../memory-estimate/service.js";
import { resolveGgufShardPaths } from "../models/gguf.js";
import { listMemoryPools } from "../resources/repository.js";
import { canonicalJsonDigest as digest } from "../utils/canonical-json.js";
import { sortedByKey } from "../utils/sort.js";
import {
  artifactIdentities,
  cachedFingerprint,
  fileIdentity,
  normalizedPath,
} from "./fingerprint.js";
import {
  exceedsTolerance,
  type AnalyticalReceipt,
  type FileIdentity,
  type MemoryAssessmentFingerprint,
  type MemoryAssessmentValidation,
} from "./receipt.js";

const TELEMETRY_MIN_TOLERANCE_BYTES = 256 * 1024 * 1024;
const TELEMETRY_RELATIVE_TOLERANCE = 0.1;
const LOG_BUFFER_MIN_TOLERANCE_BYTES = 128 * 1024 * 1024;
const LOG_BUFFER_RELATIVE_TOLERANCE = 0.08;

const LLAMA_UPDATE_RECOMMENDATION =
  "Update both Arriero and llama.cpp, rebuild the current llama-server and llama-fit-params pair, then run the memory assessment again. If the mismatch remains, export the diagnostic report for a developer.";

const PYTHON_UPDATE_RECOMMENDATION =
  "Re-run the estimate or capture a new measured baseline after the environment, model, or configuration change, then apply the updated draws.";

type AssessmentWording = {
  verified: string;
  mismatch: string;
  pending: string;
  inconclusive: string;
};

type AssessmentAnalytical = {
  estimatorId: string;
  wording: AssessmentWording;
  validate(
    receipt: AnalyticalReceipt,
    layout: InstanceMemoryLayout,
    runId: string | null,
  ): MemoryAssessmentValidation | null;
};

type FingerprintAdapter = {
  buildFingerprint(context: MemoryEstimateContext): MemoryAssessmentFingerprint;
  driftReasons(
    stored: MemoryAssessmentFingerprint,
    current: MemoryAssessmentFingerprint,
  ): string[];
};

type AssessmentProfile = {
  analytical: AssessmentAnalytical | null;
  notAssessedRecommendation: string;
  updateRecommendation: string;
};

export type AssessmentEngine = AssessmentProfile & FingerprintAdapter;

export function telemetryToleranceBytes(expectedBytes: number): number {
  return Math.max(
    TELEMETRY_MIN_TOLERANCE_BYTES,
    Math.round(expectedBytes * TELEMETRY_RELATIVE_TOLERANCE),
  );
}

function configDigestFor(context: MemoryEstimateContext): string {
  return digest({
    kind: context.kind,
    args: context.args,
    positionalArgs: context.positionalArgs,
    env: context.env,
    rpcWorkers: context.rpcWorkers,
    ...(context.engineConfig ? { engineConfig: context.engineConfig } : {}),
  });
}

function hardwareDigestFor(
  args: MemoryEstimateArgs,
  env: Record<string, string>,
): string {
  const selectedPools = new Set(
    poolsForEstimate(args, env).map((pool) => pool.id),
  );
  const hardware = listMemoryPools()
    .filter((pool) => selectedPools.has(pool.id))
    .map((pool) => ({
      id: pool.id,
      kind: pool.kind,
      capacityBytes: pool.capacityBytes,
      deviceRef: pool.deviceRef,
    }));
  return digest(hardware);
}

function uniqueByPath(entries: FileIdentity[]): FileIdentity[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

function llamaArtifactIdentities(args: MemoryEstimateArgs): FileIdentity[] {
  const modelPath = resolveModelPath(args);
  const auxiliary = auxiliaryGgufPaths(args);
  const candidates = [
    ...(modelPath ? [modelPath] : []),
    ...[...MMPROJ_ARG_KEYS, ...DRAFT_MODEL_ARG_KEYS].flatMap((key) =>
      typeof args[key] === "string" ? [args[key]] : [],
    ),
    ...auxiliary.loraPaths,
    ...auxiliary.controlVectorPaths,
  ].filter((path): path is string => Boolean(path && existsSync(path)));
  const expanded = candidates.flatMap((path) => {
    try {
      return resolveGgufShardPaths(path);
    } catch {
      return [path];
    }
  });
  return [...new Set(expanded.map(normalizedPath))]
    .map(fileIdentity)
    .filter((entry): entry is FileIdentity => entry !== null);
}

function llamaRuntimeFileIdentities(binaryPath: string): FileIdentity[] {
  const binary = fileIdentity(binaryPath);
  if (!binary) return [];
  const directory = dirname(binary.path);
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return [binary];
  }
  const llamaLibrary =
    /^(?:lib)?(?:ggml|llama|mtmd).*(?:\.so(?:\.\d+)*|\.dylib|\.dll)$/i;
  const libraries = names
    .filter((name) => llamaLibrary.test(name))
    .map((name) => fileIdentity(resolve(directory, name)))
    .filter((entry): entry is FileIdentity => entry !== null);
  return sortedByKey([binary, ...libraries], (entry) => entry.path);
}

function llamaFingerprint(
  context: MemoryEstimateContext,
): MemoryAssessmentFingerprint {
  const configDigest = configDigestFor(context);
  return cachedFingerprint(
    `${context.kind}|${configDigest}|${context.binaryPath}`,
    () => {
      const args = resolveLlamaArgumentEnvironment(context.args, context.env);
      let currentBinaryPath = "";
      try {
        currentBinaryPath = normalizedPath(defaultBinaryPath());
      } catch {
        currentBinaryPath = "";
      }
      return {
        configDigest,
        hardwareDigest: hardwareDigestFor(args, context.env),
        binary: fileIdentity(context.binaryPath),
        runtimeFiles: llamaRuntimeFileIdentities(context.binaryPath),
        artifacts: llamaArtifactIdentities(args),
        currentBinaryPath,
      };
    },
  );
}

function llamaDriftReasons(
  stored: MemoryAssessmentFingerprint,
  current: MemoryAssessmentFingerprint,
): string[] {
  const reasons: string[] = [];
  if (
    current.binary === null ||
    current.binary.path !== current.currentBinaryPath
  ) {
    reasons.push(
      "The selected llama-server is not the current binary known to Arriero.",
    );
  }
  if (stored.configDigest !== current.configDigest) {
    reasons.push("Memory-affecting instance arguments or environment changed.");
  }
  if (JSON.stringify(stored.binary) !== JSON.stringify(current.binary)) {
    reasons.push("The llama-server binary changed since the estimate.");
  }
  if (
    JSON.stringify(stored.runtimeFiles) !== JSON.stringify(current.runtimeFiles)
  ) {
    reasons.push("The llama.cpp runtime libraries changed since the estimate.");
  }
  if (JSON.stringify(stored.artifacts) !== JSON.stringify(current.artifacts)) {
    reasons.push(
      "The model, draft model, mmproj, LoRA, control vector, or GGUF shards changed.",
    );
  }
  if (stored.hardwareDigest !== current.hardwareDigest) {
    reasons.push("The selected memory-pool hardware changed.");
  }
  if (stored.currentBinaryPath !== current.currentBinaryPath) {
    reasons.push(
      "Arriero now considers a different llama-server binary current.",
    );
  }
  return reasons;
}

function expectedRuntimeBytes(
  receipt: AnalyticalReceipt,
  kind: "gpu" | "host",
): number {
  return receipt.estimate.pools
    .filter((pool) => pool.kind === kind)
    .reduce(
      (sum, pool) => sum + pool.weightsBytes + pool.kvBytes + pool.computeBytes,
      0,
    );
}

function validateLlamaLogBuffers(
  receipt: AnalyticalReceipt,
  layout: InstanceMemoryLayout,
): MemoryAssessmentValidation | null {
  if (layout.source !== "log-buffers" || layout.totalBytes <= 0) return null;
  if (layout.otherBytes > 0) {
    return {
      source: "log-buffers",
      observedAt: new Date().toISOString(),
      runId: null,
      verdict: "inconclusive",
      deltas: [],
    };
  }
  const pairs = [
    {
      scope: "gpu" as const,
      expectedBytes: expectedRuntimeBytes(receipt, "gpu"),
      observedBytes: layout.deviceBytes,
    },
    {
      scope: "host" as const,
      expectedBytes: expectedRuntimeBytes(receipt, "host"),
      observedBytes: layout.hostBytes,
    },
  ].filter((entry) => entry.expectedBytes > 0 || entry.observedBytes > 0);
  const deltas = pairs.map((entry) => {
    const toleranceBytes = Math.max(
      LOG_BUFFER_MIN_TOLERANCE_BYTES,
      Math.round(entry.expectedBytes * LOG_BUFFER_RELATIVE_TOLERANCE),
    );
    return {
      ...entry,
      deltaBytes: entry.observedBytes - entry.expectedBytes,
      toleranceBytes,
    };
  });
  return {
    source: "log-buffers",
    observedAt: new Date().toISOString(),
    runId: null,
    verdict: deltas.some(exceedsTolerance) ? "mismatch" : "verified",
    deltas,
  };
}

function validateVllmGpuReservation(
  receipt: AnalyticalReceipt,
  layout: InstanceMemoryLayout,
  runId: string | null,
): MemoryAssessmentValidation | null {
  if (layout.source !== "process-telemetry" || layout.totalBytes <= 0) {
    return null;
  }
  if (!runId) return null;
  const expectedBytes = receipt.estimate.pools
    .filter((pool) => pool.kind === "gpu")
    .reduce((sum, pool) => sum + pool.totalBytes, 0);
  if (expectedBytes <= 0) return null;
  const delta = {
    scope: "gpu" as const,
    expectedBytes,
    observedBytes: layout.deviceBytes,
    deltaBytes: layout.deviceBytes - expectedBytes,
    toleranceBytes: telemetryToleranceBytes(expectedBytes),
  };
  return {
    source: "process-telemetry",
    observedAt: new Date().toISOString(),
    runId,
    verdict: exceedsTolerance(delta) ? "mismatch" : "verified",
    deltas: [delta],
  };
}

function pythonRuntimeFileIdentities(binaryPath: string): FileIdentity[] {
  const binary = fileIdentity(binaryPath);
  if (!binary) return [];
  const binDirectory = dirname(binary.path);
  const environmentRoot = dirname(binDirectory);
  const companions = [
    resolve(binDirectory, "python"),
    resolve(binDirectory, "python3"),
    resolve(environmentRoot, "pyvenv.cfg"),
    resolve(environmentRoot, "freeze.txt"),
  ]
    .map(fileIdentity)
    .filter((entry): entry is FileIdentity => entry !== null);
  return sortedByKey(
    uniqueByPath([binary, ...companions]),
    (entry) => entry.path,
  );
}

function pythonModelArtifacts(context: MemoryEstimateContext): FileIdentity[] {
  const ktConfig =
    context.engineConfig?.type === "ktransformers"
      ? context.engineConfig
      : null;
  const positional = context.positionalArgs.find((item) => item.trim());
  const argCandidates = ["--model", "--model-path"].flatMap((key) => {
    const value = context.args[key];
    return typeof value === "string" ? [value] : [];
  });
  const candidates = [
    ...(ktConfig ? [ktConfig.model, ktConfig.cpuWeights] : []),
    ...(positional ? [positional] : []),
    ...argCandidates,
  ].filter((value) => value.trim().length > 0);
  return uniqueByPath(candidates.flatMap((path) => artifactIdentities(path)));
}

function pythonEnvFingerprint(
  context: MemoryEstimateContext,
): MemoryAssessmentFingerprint {
  const configDigest = configDigestFor(context);
  return cachedFingerprint(
    `${context.kind}|${configDigest}|${context.binaryPath}`,
    () => ({
      configDigest,
      hardwareDigest: hardwareDigestFor(context.args, context.env),
      binary: fileIdentity(context.binaryPath),
      runtimeFiles: pythonRuntimeFileIdentities(context.binaryPath),
      artifacts: pythonModelArtifacts(context),
      currentBinaryPath: "",
    }),
  );
}

function pythonDriftReasons(
  stored: MemoryAssessmentFingerprint,
  current: MemoryAssessmentFingerprint,
): string[] {
  const reasons: string[] = [];
  if (stored.configDigest !== current.configDigest) {
    reasons.push(
      "Memory-affecting instance arguments, environment, or engine configuration changed.",
    );
  }
  if (JSON.stringify(stored.binary) !== JSON.stringify(current.binary)) {
    reasons.push(
      current.binary === null
        ? "The engine entrypoint is missing."
        : "The engine entrypoint changed since the assessment.",
    );
  }
  if (
    JSON.stringify(stored.runtimeFiles) !== JSON.stringify(current.runtimeFiles)
  ) {
    reasons.push("The Python environment changed since the assessment.");
  }
  if (JSON.stringify(stored.artifacts) !== JSON.stringify(current.artifacts)) {
    reasons.push("The model files changed since the assessment.");
  }
  if (stored.hardwareDigest !== current.hardwareDigest) {
    reasons.push("The selected memory-pool hardware changed.");
  }
  return reasons;
}

const FINGERPRINT_ADAPTERS: Record<
  Exclude<EngineAssessmentFingerprintId, "none">,
  FingerprintAdapter
> = {
  "llama-binary-gguf": {
    buildFingerprint: llamaFingerprint,
    driftReasons: llamaDriftReasons,
  },
  "python-env": {
    buildFingerprint: pythonEnvFingerprint,
    driftReasons: pythonDriftReasons,
  },
};

function composedEngine(
  kind: InstanceKind,
  profile: AssessmentProfile,
): AssessmentEngine | null {
  const fingerprintId = engineDescriptor(kind).assessment.fingerprint;
  if (fingerprintId === "none") return null;
  return { ...profile, ...FINGERPRINT_ADAPTERS[fingerprintId] };
}

const ASSESSMENT_ENGINES: Record<InstanceKind, AssessmentEngine | null> = {
  "llama-server": composedEngine("llama-server", {
    analytical: {
      estimatorId: "llama.cpp-gguf",
      wording: {
        verified:
          "The estimate matches llama.cpp's reported buffer allocation.",
        mismatch:
          "Observed llama.cpp buffer allocation differs from Arriero's estimate.",
        pending:
          "The estimate is current, but no exact llama.cpp buffer allocation has been captured yet.",
        inconclusive:
          "llama.cpp reported exact buffers, but Arriero could not map every allocation to RAM or VRAM.",
      },
      validate: validateLlamaLogBuffers,
    },
    notAssessedRecommendation:
      "Run Estimate memory in the instance editor and save the resulting assessment.",
    updateRecommendation: LLAMA_UPDATE_RECOMMENDATION,
  }),
  "rpc-worker": null,
  vllm: composedEngine("vllm", {
    analytical: {
      estimatorId: "vllm-gpu-util",
      wording: {
        verified:
          "Observed GPU memory matches the reserved utilization fraction.",
        mismatch:
          "Observed GPU memory differs from the reserved utilization fraction.",
        pending:
          "The estimate is current; GPU usage is compared against it on the next observed run.",
        inconclusive:
          "Runtime telemetry could not be compared against the reservation.",
      },
      validate: validateVllmGpuReservation,
    },
    notAssessedRecommendation:
      "Run Estimate footprint with an explicit --gpu-memory-utilization and save the assessment, or capture a measured baseline while the instance is running; host RAM draws stay manual.",
    updateRecommendation: PYTHON_UPDATE_RECOMMENDATION,
  }),
  ktransformers: composedEngine("ktransformers", {
    analytical: null,
    notAssessedRecommendation:
      "KTransformers has no analytical estimator; capture a measured baseline while the instance is running and apply it as declared draws.",
    updateRecommendation:
      "Capture a new measured baseline after the environment, model, or configuration change, then apply the updated draws.",
  }),
};

export function assessmentEngine(kind: InstanceKind): AssessmentEngine | null {
  return ASSESSMENT_ENGINES[kind];
}
