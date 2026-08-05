import {
  MEMORY_ESTIMATOR_VERSION,
  MemoryAssessmentDeltaSchema,
  MemoryAssessmentValidationSourceSchema,
  MemoryEstimateSchema,
  engineDescriptor,
  type Instance,
  type InstanceHealthSummary,
  type InstanceMemoryLayout,
  type MemoryAssessmentDelta,
  type MemoryAssessmentSummary,
  type MemoryEstimate,
} from "@arriero/core";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { defaultBinaryPath } from "../arguments/binary-discovery.js";
import { getInstance } from "../instances/repository.js";
import { resolveGgufShardPaths } from "../models/gguf.js";
import { listMemoryPools } from "../resources/repository.js";
import { getAppVersion } from "../update/version.js";
import { canonicalJsonDigest as digest } from "../utils/canonical-json.js";
import {
  auxiliaryGgufPaths,
  contextFromInstance,
  poolsForEstimate,
  resolveLlamaArgumentEnvironment,
  DRAFT_MODEL_ARG_KEYS,
  MMPROJ_ARG_KEYS,
  type MemoryEstimateContext,
  type MemoryEstimateResolution,
} from "../memory-estimate/service.js";
import {
  bindMemoryAssessment as bindStoredAssessment,
  createMemoryAssessmentDraft as createStoredDraft,
  getMemoryAssessmentById,
  getMemoryAssessmentForInstance,
  updateMemoryAssessmentReceipt,
} from "./repository.js";

const ESTIMATOR_ID = "llama.cpp-gguf";
const VALIDATION_MIN_TOLERANCE = 128 * 1024 * 1024;
const VALIDATION_RELATIVE_TOLERANCE = 0.08;

export const MEMORY_ASSESSMENT_UPDATE_RECOMMENDATION =
  "Update both Arriero and llama.cpp, rebuild the current llama-server and llama-fit-params pair, then run the memory assessment again. If the mismatch remains, export the diagnostic report for a developer.";

const FileIdentitySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
});

const FingerprintSchema = z.object({
  digest: z.string(),
  configDigest: z.string(),
  hardwareDigest: z.string(),
  binary: FileIdentitySchema.nullable(),
  runtimeFiles: z.array(FileIdentitySchema),
  artifacts: z.array(FileIdentitySchema),
  currentBinaryPath: z.string(),
});

const ValidationSchema = z.object({
  source: MemoryAssessmentValidationSourceSchema.exclude(["none"]),
  observedAt: z.string(),
  verdict: z.enum(["verified", "mismatch", "inconclusive"]),
  deltas: z.array(MemoryAssessmentDeltaSchema),
});

const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  estimatorId: z.literal(ESTIMATOR_ID),
  estimatorVersion: z.number().int(),
  createdAt: z.string(),
  fingerprint: FingerprintSchema,
  estimate: MemoryEstimateSchema,
  appliedDrawsDigest: z.string().nullable(),
  validation: ValidationSchema.nullable(),
});

type MemoryAssessmentFingerprint = z.infer<typeof FingerprintSchema>;
type MemoryAssessmentValidation = z.infer<typeof ValidationSchema>;
type MemoryAssessmentReceipt = z.infer<typeof ReceiptSchema>;

function normalizedPath(path: string): string {
  if (!path) return "";
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function fileIdentity(path: string): z.infer<typeof FileIdentitySchema> | null {
  try {
    if (!path || !existsSync(path)) return null;
    const normalized = normalizedPath(path);
    const stat = statSync(normalized);
    return {
      path: normalized,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function artifactPaths(context: MemoryEstimateContext, modelPath: string) {
  const auxiliary = auxiliaryGgufPaths(context.args);
  const candidates = [
    modelPath,
    ...[...MMPROJ_ARG_KEYS, ...DRAFT_MODEL_ARG_KEYS].flatMap((key) =>
      typeof context.args[key] === "string" ? [context.args[key]] : [],
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
  return [...new Set(expanded.map(normalizedPath))];
}

function runtimeFileIdentities(binaryPath: string) {
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
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return [binary, ...libraries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

const FINGERPRINT_CACHE_TTL_MS = 10_000;
const FINGERPRINT_CACHE_LIMIT = 128;
const fingerprintCache = new Map<
  string,
  { fingerprint: MemoryAssessmentFingerprint; expiresAt: number }
>();

function buildFingerprint(
  context: MemoryEstimateContext,
  modelPath: string,
): MemoryAssessmentFingerprint {
  const configDigest = digest({
    kind: context.kind,
    args: context.args,
    positionalArgs: context.positionalArgs,
    env: context.env,
    rpcWorkers: context.rpcWorkers,
  });
  const cacheKey = `${configDigest}|${context.binaryPath}|${modelPath}`;
  const cached = fingerprintCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.fingerprint;
  }

  const effectiveContext =
    context.kind === "llama-server"
      ? {
          ...context,
          args: resolveLlamaArgumentEnvironment(context.args, context.env),
        }
      : context;
  const selectedPools = new Set(
    poolsForEstimate(effectiveContext.args, context.env).map((pool) => pool.id),
  );
  const hardware = listMemoryPools()
    .filter((pool) => selectedPools.has(pool.id))
    .map((pool) => ({
      id: pool.id,
      kind: pool.kind,
      capacityBytes: pool.capacityBytes,
      deviceRef: pool.deviceRef,
    }));
  const binary = fileIdentity(context.binaryPath);
  const runtimeFiles = runtimeFileIdentities(context.binaryPath);
  let currentBinaryPath = "";
  try {
    currentBinaryPath = normalizedPath(defaultBinaryPath());
  } catch {
    currentBinaryPath = "";
  }
  const artifacts = artifactPaths(effectiveContext, modelPath)
    .map(fileIdentity)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const hardwareDigest = digest(hardware);
  const fingerprintBase = {
    configDigest,
    hardwareDigest,
    binary,
    runtimeFiles,
    artifacts,
    currentBinaryPath,
  };
  const fingerprint = { ...fingerprintBase, digest: digest(fingerprintBase) };
  fingerprintCache.set(cacheKey, {
    fingerprint,
    expiresAt: Date.now() + FINGERPRINT_CACHE_TTL_MS,
  });
  while (fingerprintCache.size > FINGERPRINT_CACHE_LIMIT) {
    const oldest = fingerprintCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    fingerprintCache.delete(oldest);
  }
  return fingerprint;
}

function drawsDigest(draws: Instance["memory"]): string {
  return digest(
    [...draws]
      .map((draw) => ({ poolId: draw.poolId, bytes: draw.bytes }))
      .sort((left, right) => left.poolId.localeCompare(right.poolId)),
  );
}

export function createMemoryAssessment(
  result: Extract<MemoryEstimateResolution, { ok: true }>,
): string | null {
  const context = result.context;
  if (
    context.kind !== "llama-server" ||
    engineDescriptor(context.kind).estimator !== "gguf"
  ) {
    return null;
  }
  const createdAt = new Date().toISOString();
  const receipt: MemoryAssessmentReceipt = {
    schemaVersion: 1,
    estimatorId: ESTIMATOR_ID,
    estimatorVersion: MEMORY_ESTIMATOR_VERSION,
    createdAt,
    fingerprint: buildFingerprint(context, result.modelPath),
    estimate: result.estimate,
    appliedDrawsDigest: null,
    validation: null,
  };
  return createStoredDraft(receipt).id;
}

export function bindMemoryAssessmentToInstance(
  assessmentId: string,
  instanceId: string,
): MemoryAssessmentSummary {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error("instance not found");
  const stored = getMemoryAssessmentById(assessmentId);
  if (!stored) throw new Error("memory assessment not found");
  if (stored.instanceId && stored.instanceId !== instanceId) {
    throw new Error("memory assessment is already bound to another instance");
  }
  const parsed = ReceiptSchema.safeParse(stored.receipt);
  if (!parsed.success) throw new Error("memory assessment receipt is invalid");
  const receipt = parsed.data;
  const modelPath = receipt.fingerprint.artifacts[0]?.path;
  if (!modelPath) throw new Error("memory assessment has no model artifact");
  const current = buildFingerprint(contextFromInstance(instance), modelPath);
  if (current.digest !== receipt.fingerprint.digest) {
    throw new Error(
      "instance, binary, model files, or hardware changed after the estimate; run it again",
    );
  }
  const currentDrawsDigest = drawsDigest(instance.memory);
  const estimateDrawsDigest = drawsDigest(receipt.estimate.draws);
  const bound: MemoryAssessmentReceipt = {
    ...receipt,
    appliedDrawsDigest:
      currentDrawsDigest === estimateDrawsDigest ? currentDrawsDigest : null,
  };
  bindStoredAssessment(assessmentId, instanceId, bound);
  return evaluateInstanceMemoryAssessment(instance) ?? notAssessedSummary();
}

function reservationStatus(
  instance: Instance,
  receipt: MemoryAssessmentReceipt,
): MemoryAssessmentSummary["reservationStatus"] {
  if (!receipt.appliedDrawsDigest) return "not-applied";
  return drawsDigest(instance.memory) === receipt.appliedDrawsDigest
    ? "applied"
    : "modified";
}

function fingerprintDriftReasons(
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

function expectedRuntimeBytes(estimate: MemoryEstimate, kind: "gpu" | "host") {
  return estimate.pools
    .filter((pool) => pool.kind === kind)
    .reduce(
      (sum, pool) => sum + pool.weightsBytes + pool.kvBytes + pool.computeBytes,
      0,
    );
}

export function validateMemoryAssessmentLayout(
  estimate: MemoryEstimate,
  layout: InstanceMemoryLayout,
): MemoryAssessmentValidation | null {
  if (layout.source !== "log-buffers" || layout.totalBytes <= 0) return null;
  if (layout.otherBytes > 0) {
    return {
      source: "log-buffers",
      observedAt: new Date().toISOString(),
      verdict: "inconclusive",
      deltas: [],
    };
  }
  const pairs = [
    {
      scope: "gpu" as const,
      expectedBytes: expectedRuntimeBytes(estimate, "gpu"),
      observedBytes: layout.deviceBytes,
    },
    {
      scope: "host" as const,
      expectedBytes: expectedRuntimeBytes(estimate, "host"),
      observedBytes: layout.hostBytes,
    },
  ].filter((entry) => entry.expectedBytes > 0 || entry.observedBytes > 0);
  const deltas: MemoryAssessmentDelta[] = pairs.map((entry) => {
    const toleranceBytes = Math.max(
      VALIDATION_MIN_TOLERANCE,
      Math.round(entry.expectedBytes * VALIDATION_RELATIVE_TOLERANCE),
    );
    return {
      ...entry,
      deltaBytes: entry.observedBytes - entry.expectedBytes,
      toleranceBytes,
    };
  });
  const mismatch = deltas.some(
    (entry) => Math.abs(entry.deltaBytes) > entry.toleranceBytes,
  );
  return {
    source: "log-buffers",
    observedAt: new Date().toISOString(),
    verdict: mismatch ? "mismatch" : "verified",
    deltas,
  };
}

function notAssessedSummary(): MemoryAssessmentSummary {
  return {
    status: "not-assessed",
    reason: "Memory has not been assessed for this instance configuration.",
    reasons: [],
    recommendation:
      "Run Estimate memory in the instance editor and save the resulting assessment.",
    assessedAt: null,
    estimatorId: null,
    estimatorVersion: null,
    confidence: null,
    reservationStatus: "not-applied",
    validationSource: "none",
    deltas: [],
    reportAvailable: false,
  };
}

export function evaluateInstanceMemoryAssessment(
  instance: Instance,
  layout?: InstanceMemoryLayout,
): MemoryAssessmentSummary | undefined {
  if (instance.kind !== "llama-server") return undefined;
  const stored = getMemoryAssessmentForInstance(instance.name);
  if (!stored) return notAssessedSummary();
  const parsed = ReceiptSchema.safeParse(stored.receipt);
  if (!parsed.success) {
    return {
      ...notAssessedSummary(),
      status: "update-required",
      reason:
        "The stored memory assessment cannot be read by this Arriero version.",
      reasons: ["The local assessment receipt is invalid or obsolete."],
      recommendation: MEMORY_ASSESSMENT_UPDATE_RECOMMENDATION,
      reportAvailable: true,
    };
  }
  let receipt = parsed.data;
  const modelPath = receipt.fingerprint.artifacts[0]?.path ?? "";
  const current = buildFingerprint(contextFromInstance(instance), modelPath);
  const reasons = fingerprintDriftReasons(receipt.fingerprint, current);
  if (receipt.estimatorVersion !== MEMORY_ESTIMATOR_VERSION) {
    reasons.unshift(
      "Arriero's memory estimator changed since this assessment.",
    );
  }
  const receiptBase = {
    assessedAt: receipt.createdAt,
    estimatorId: receipt.estimatorId,
    estimatorVersion: receipt.estimatorVersion,
    confidence: receipt.estimate.confidence,
    reservationStatus: reservationStatus(instance, receipt),
    reportAvailable: true,
  };
  if (reasons.length > 0) {
    return {
      ...receiptBase,
      status: "update-required",
      reason: reasons[0] ?? "The memory assessment is stale.",
      reasons,
      recommendation: MEMORY_ASSESSMENT_UPDATE_RECOMMENDATION,
      validationSource: receipt.validation?.source ?? "none",
      deltas: receipt.validation?.deltas ?? [],
    };
  }

  const validation = layout
    ? validateMemoryAssessmentLayout(receipt.estimate, layout)
    : null;
  if (
    validation &&
    digest({ ...validation, observedAt: null }) !==
      digest({ ...receipt.validation, observedAt: null })
  ) {
    receipt = { ...receipt, validation };
    updateMemoryAssessmentReceipt(stored.id, receipt);
  }
  const effectiveValidation = validation ?? receipt.validation;
  const base = {
    ...receiptBase,
    validationSource: effectiveValidation?.source ?? ("none" as const),
    deltas: effectiveValidation?.deltas ?? [],
  };
  if (effectiveValidation?.verdict === "mismatch") {
    return {
      ...base,
      status: "mismatch",
      reason:
        "Observed llama.cpp buffer allocation differs from Arriero's estimate.",
      reasons: effectiveValidation.deltas
        .filter((entry) => Math.abs(entry.deltaBytes) > entry.toleranceBytes)
        .map(
          (entry) =>
            `${entry.scope.toUpperCase()} differs by ${entry.deltaBytes} bytes (tolerance ${entry.toleranceBytes}).`,
        ),
      recommendation: MEMORY_ASSESSMENT_UPDATE_RECOMMENDATION,
    };
  }
  if (effectiveValidation?.verdict === "verified") {
    return {
      ...base,
      status: "verified",
      reason: "The estimate matches llama.cpp's reported buffer allocation.",
      reasons: [],
      recommendation: null,
    };
  }
  return {
    ...base,
    status: "analytical",
    reason:
      effectiveValidation?.verdict === "inconclusive"
        ? "llama.cpp reported exact buffers, but Arriero could not map every allocation to RAM or VRAM."
        : "The estimate is current, but no exact llama.cpp buffer allocation has been captured yet.",
    reasons:
      receipt.estimate.confidence === "low"
        ? ["The estimator reported low confidence for this model layout."]
        : [],
    recommendation: null,
  };
}

function redactRecord<T>(record: Record<string, T>) {
  const sensitive = /(token|key|secret|password|auth|credential)/i;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitive.test(key) ? "[redacted]" : value,
    ]),
  );
}

export function buildMemoryAssessmentReport(
  instance: Instance,
  health: InstanceHealthSummary,
) {
  const stored = getMemoryAssessmentForInstance(instance.name);
  const parsedReceipt = stored ? ReceiptSchema.safeParse(stored.receipt) : null;
  const receipt = parsedReceipt?.success
    ? parsedReceipt.data
    : (stored?.receipt ?? null);
  const modelPath = parsedReceipt?.success
    ? (parsedReceipt.data.fingerprint.artifacts[0]?.path ?? "")
    : "";
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    app: getAppVersion(),
    estimator: { id: ESTIMATOR_ID, version: MEMORY_ESTIMATOR_VERSION },
    instance: {
      name: instance.name,
      kind: instance.kind,
      binaryPath: instance.binaryPath,
      binaryPathRefId: instance.binaryPathRefId,
      args: redactRecord(instance.args),
      positionalArgs: instance.positionalArgs ?? [],
      env: redactRecord(instance.env),
      memory: instance.memory,
    },
    assessment: health.memoryAssessment ?? null,
    receipt,
    currentFingerprint:
      modelPath && instance.kind === "llama-server"
        ? buildFingerprint(contextFromInstance(instance), modelPath)
        : null,
    runtime: health.runtime,
    configDrift: health.configDrift,
    memoryLayout: health.logSummary.memoryLayout,
  };
}
