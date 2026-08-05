import type {
  InstanceHealthSummary,
  InstanceLoadProgress,
  EndpointProbe,
  LlamaModelActionName,
  LlamaProbe,
  LlamaSlotActionName,
  MemoryAssessmentStatus,
} from "@arriero/core";

import { formatLocalDateTime } from "../utils/time";

export const memoryAssessmentStatusColors: Record<
  MemoryAssessmentStatus,
  string
> = {
  "not-assessed": "gray",
  "update-required": "orange",
  analytical: "blue",
  verified: "green",
  mismatch: "red",
};

export type V1ModelInfo = {
  id: string;
  object: string | null;
  ownedBy: string | null;
  created: string | null;
  aliases: string[];
  tags: string[];
  status: string | null;
  modelPath: string | null;
  ctxSize: string | null;
  nGpuLayers: string | null;
  loadOnStartup: string | null;
  stopTimeout: string | null;
  modalities: string | null;
  failed: boolean;
  exitCode: string | null;
  meta: V1ModelMeta | null;
  diagnosticArgs: string[];
  diagnosticPreset: string | null;
  unknownExtras: Array<[string, string]>;
};

type V1ModelMeta = {
  nParams: number | null;
  sizeBytes: number | null;
  nCtx: number | null;
  nCtxTrain: number | null;
  nVocab: number | null;
  nEmbd: number | null;
  vocabType: number | null;
};

export type RouterModelAction = Exclude<LlamaModelActionName, "reload">;
export type SlotActionInput = {
  model: string | null;
  slotId: number;
  action: LlamaSlotActionName;
  filename?: string;
};

function probeEndpointMessage(probe: EndpointProbe | undefined) {
  const body = probe?.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }
  return probe?.error ?? null;
}

function isModelScopedRouterProbe(probe: EndpointProbe | undefined) {
  return (
    probe?.status === 400 &&
    /model name is missing from the request/i.test(
      probeEndpointMessage(probe) ?? "",
    )
  );
}

export function probeColor(probe: EndpointProbe | undefined) {
  if (!probe) return "gray";
  if (probe.ok) return "green";
  if (isModelScopedRouterProbe(probe)) return "yellow";
  if (probe.status === 503) return "yellow";
  return "red";
}

export function probeTooltip(probe: EndpointProbe | undefined) {
  if (!probe) return "not probed";
  const parts = [`${probe.status} · ${probe.latencyMs} ms`];
  if (isModelScopedRouterProbe(probe)) {
    parts.push("router endpoint requires a model (see per-model diagnostics)");
  } else if (probe.error) {
    parts.push(probe.error);
  }
  return parts.join(" · ");
}

export function slowestProbe(
  probes: Array<[string, EndpointProbe | undefined]>,
) {
  let slowest: { label: string; latencyMs: number } | null = null;
  for (const [label, probe] of probes) {
    if (!probe) continue;
    if (!slowest || probe.latencyMs > slowest.latencyMs) {
      slowest = { label, latencyMs: probe.latencyMs };
    }
  }
  return slowest;
}

export function propsSummary(
  probe: LlamaProbe | undefined,
): Array<[string, unknown]> {
  const body = probe?.props.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }

  const record = body as Record<string, unknown>;
  const entries: Array<[string, unknown]> = [
    ["Model", record.model_alias],
    ["Path", record.model_path],
    ["Slots", record.total_slots],
    ["Build", record.build_info],
    ["Sleeping", record.is_sleeping],
  ];

  return entries.filter(([, value]) => value !== undefined && value !== null);
}

export function jsonValuePreview(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatModelCreated(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return String(value);
    return formatLocalDateTime(new Date(value * 1000).toISOString());
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return formatModelCreated(asNumber);
    }
    return value;
  }
  return null;
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatInteger(value: number | null) {
  return value === null ? null : new Intl.NumberFormat().format(value);
}

export function formatCompactCount(value: number | null) {
  if (value === null) return null;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}K`;
  }
  return String(value);
}

export function formatBytes(value: number | null) {
  if (value === null) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (Math.abs(scaled) >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function modelMetaFromRecord(value: unknown): V1ModelMeta | null {
  const meta = objectRecord(value);
  if (!meta) {
    return null;
  }
  return {
    nParams: numberValue(meta.n_params),
    sizeBytes: numberValue(meta.size),
    nCtx: numberValue(meta.n_ctx),
    nCtxTrain: numberValue(meta.n_ctx_train),
    nVocab: numberValue(meta.n_vocab),
    nEmbd: numberValue(meta.n_embd),
    vocabType: numberValue(meta.vocab_type),
  };
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) =>
      typeof item === "string" || typeof item === "number"
        ? String(item)
        : null,
    )
    .filter((item): item is string => Boolean(item));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valueFromArgv(args: string[], names: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) {
      continue;
    }
    for (const name of names) {
      if (current === name) {
        const next = args[index + 1];
        return next && !next.startsWith("--") ? next : null;
      }
      if (current.startsWith(`${name}=`)) {
        return current.slice(name.length + 1);
      }
    }
  }
  return null;
}

function valueFromPreset(preset: string | null, key: string) {
  if (!preset) {
    return null;
  }
  const match = preset.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`, "im"),
  );
  return match?.[1]?.trim() || null;
}

function firstConfigValue(input: {
  args: string[];
  preset: string | null;
  argNames: string[];
  presetKey: string;
}) {
  return (
    valueFromArgv(input.args, input.argNames) ??
    valueFromPreset(input.preset, input.presetKey)
  );
}

export function modelStatusColor(status: string | null) {
  const normalized = status?.toLowerCase() ?? "";
  if (["loaded", "ready", "running"].includes(normalized)) return "green";
  if (["loading", "starting"].includes(normalized)) return "yellow";
  if (["error", "failed"].includes(normalized)) return "red";
  if (["unloading", "stopping"].includes(normalized)) return "orange";
  return "gray";
}

function formatStartupMode(value: string | null) {
  if (value === null) return null;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
    return "autoload";
  }
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
    return "manual";
  }
  return value;
}

function architectureModalities(value: unknown) {
  const architecture = objectRecord(value);
  if (!architecture) {
    return null;
  }
  const input = stringArray(architecture.input_modalities);
  const output = stringArray(architecture.output_modalities);
  if (input.length === 0 && output.length === 0) {
    return null;
  }
  return `${input.join(", ") || "?"} -> ${output.join(", ") || "?"}`;
}

function compareV1ModelIds(left: { id: string }, right: { id: string }) {
  return left.id.localeCompare(right.id, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function v1ModelsFromProbe(
  probe: EndpointProbe | undefined,
): V1ModelInfo[] {
  const body = probe?.body;
  const data = Array.isArray(body)
    ? body
    : body &&
        typeof body === "object" &&
        Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];

  return data
    .map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return {
          id: String(item ?? `model-${index + 1}`),
          object: null,
          ownedBy: null,
          created: null,
          aliases: [],
          tags: [],
          status: null,
          modelPath: null,
          ctxSize: null,
          nGpuLayers: null,
          loadOnStartup: null,
          stopTimeout: null,
          modalities: null,
          failed: false,
          exitCode: null,
          meta: null,
          diagnosticArgs: [],
          diagnosticPreset: null,
          unknownExtras: [],
        };
      }

      const record = item as Record<string, unknown>;
      const status = objectRecord(record.status);
      const args = stringArray(status?.args);
      const preset =
        typeof status?.preset === "string" && status.preset.trim()
          ? status.preset
          : null;
      const reserved = new Set([
        "id",
        "object",
        "owned_by",
        "created",
        "aliases",
        "tags",
        "status",
        "architecture",
        "meta",
      ]);
      return {
        id: String(record.id ?? `model-${index + 1}`),
        object:
          typeof record.object === "string" && record.object
            ? record.object
            : null,
        ownedBy:
          typeof record.owned_by === "string" && record.owned_by
            ? record.owned_by
            : null,
        created: formatModelCreated(record.created),
        aliases: stringArray(record.aliases),
        tags: stringArray(record.tags),
        status:
          status?.failed === true
            ? "failed"
            : typeof status?.value === "string" && status.value
              ? status.value
              : null,
        modelPath: firstConfigValue({
          args,
          preset,
          argNames: ["--model", "-m"],
          presetKey: "model",
        }),
        ctxSize: firstConfigValue({
          args,
          preset,
          argNames: ["--ctx-size", "-c"],
          presetKey: "ctx-size",
        }),
        nGpuLayers: firstConfigValue({
          args,
          preset,
          argNames: ["--n-gpu-layers", "--gpu-layers", "-ngl"],
          presetKey: "n-gpu-layers",
        }),
        loadOnStartup: formatStartupMode(
          valueFromPreset(preset, "load-on-startup"),
        ),
        stopTimeout: valueFromPreset(preset, "stop-timeout"),
        modalities: architectureModalities(record.architecture),
        failed: status?.failed === true,
        exitCode: jsonValuePreview(status?.exit_code),
        meta: modelMetaFromRecord(record.meta),
        diagnosticArgs: args,
        diagnosticPreset: preset,
        unknownExtras: Object.entries(record)
          .filter(([key]) => !reserved.has(key))
          .map(([key, value]) => [key, jsonValuePreview(value)] as const)
          .filter((entry): entry is [string, string] => Boolean(entry[1])),
      };
    })
    .filter((model) => model.id)
    .sort(compareV1ModelIds);
}

export function isRouterModelStatus(status: string | null) {
  return ["unloaded", "loading", "loaded", "sleeping", "failed"].includes(
    status?.toLowerCase() ?? "",
  );
}

export function modelCanLoad(status: string | null) {
  return ["unloaded", "failed"].includes(status?.toLowerCase() ?? "");
}

export function modelCanUnload(status: string | null) {
  return ["loaded", "loading", "sleeping"].includes(
    status?.toLowerCase() ?? "",
  );
}

export function isModelLoading(status: string | null) {
  return status?.toLowerCase() === "loading";
}

function samePath(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left.trim() === right.trim());
}

export function modelLoadProgress(input: {
  model: V1ModelInfo;
  models: V1ModelInfo[];
  statusSummary: InstanceHealthSummary["logSummary"] | undefined;
  pendingAction: { model: string; action: RouterModelAction } | null;
}): InstanceLoadProgress | null {
  if (!isModelLoading(input.model.status)) {
    return null;
  }

  const progress = input.statusSummary?.loadProgress;
  if (!progress) {
    return null;
  }
  if (progress.stage === "ready") {
    return null;
  }

  if (samePath(input.statusSummary?.modelPath, input.model.modelPath)) {
    return progress;
  }

  const loadingModels = input.models.filter((model) =>
    isModelLoading(model.status),
  );
  const progressHasDifferentModel =
    Boolean(input.statusSummary?.modelPath) &&
    !samePath(input.statusSummary?.modelPath, input.model.modelPath);

  if (
    input.pendingAction?.model === input.model.id &&
    input.pendingAction.action === "load" &&
    !progressHasDifferentModel
  ) {
    return progress;
  }

  if (loadingModels.length === 1 && !progressHasDifferentModel) {
    return progress;
  }

  return null;
}

export function fallbackModelLoadProgress(): InstanceLoadProgress {
  return {
    stage: "pending",
    percent: null,
    message:
      "Router reports that this model is loading; waiting for matching child loading log lines.",
    estimated: true,
  };
}

export function loadProgressColor(progress: InstanceLoadProgress) {
  if (progress.stage === "error") return "red";
  if (progress.stage === "ready") return "green";
  return "yellow";
}

export function loadProgressValue(progress: InstanceLoadProgress) {
  return progress.percent ?? 10;
}

function endpointErrorText(probe: EndpointProbe | undefined) {
  return probeEndpointMessage(probe);
}

function boolLabel(value: unknown) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return null;
}

export function propsRuntimeSummary(probe: EndpointProbe | undefined) {
  if (!probe) return "not probed";
  if (!probe.ok) return endpointErrorText(probe) ?? "unavailable";
  const body = objectRecord(probe.body);
  if (!body) return "no data";

  const parts = [
    boolLabel(body.is_sleeping)
      ? `sleeping: ${boolLabel(body.is_sleeping)}`
      : null,
    numberValue(body.total_slots) !== null
      ? `slots: ${formatInteger(numberValue(body.total_slots))}`
      : null,
    boolLabel(body.endpoint_metrics)
      ? `metrics: ${boolLabel(body.endpoint_metrics)}`
      : null,
  ].filter(Boolean);

  return parts.join(" · ") || "ok";
}

export function slotsRuntimeSummary(probe: EndpointProbe | undefined) {
  if (!probe) return "not probed";
  if (!probe.ok) return endpointErrorText(probe) ?? "unavailable";
  if (!Array.isArray(probe.body)) return "no slot data";

  const slots = probe.body
    .map((slot) => objectRecord(slot))
    .filter((slot): slot is Record<string, unknown> => Boolean(slot));
  const busy = slots.filter((slot) => slot.is_processing === true).length;
  const decoded = slots.reduce(
    (sum, slot) =>
      sum + (numberValue(nextTokenRecord(slot.next_token)?.n_decoded) ?? 0),
    0,
  );
  const contexts = [
    ...new Set(
      slots
        .map((slot) => numberValue(slot.n_ctx))
        .filter((value): value is number => value !== null),
    ),
  ];

  return [
    `${busy}/${slots.length} busy`,
    decoded > 0 ? `${formatInteger(decoded)} decoded` : null,
    contexts.length > 0
      ? `ctx ${contexts.map(formatInteger).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function nextTokenRecord(value: unknown) {
  if (Array.isArray(value)) {
    return objectRecord(value[0]);
  }
  return objectRecord(value);
}

export function slotRowsFromProbe(probe: EndpointProbe | undefined) {
  if (!probe?.ok || !Array.isArray(probe.body)) {
    return [];
  }

  return probe.body
    .map((slot) => objectRecord(slot))
    .filter((slot): slot is Record<string, unknown> => Boolean(slot))
    .map((slot) => {
      const nextToken = nextTokenRecord(slot.next_token);
      const idNumber = numberValue(slot.id);
      return {
        idNumber:
          idNumber !== null && Number.isInteger(idNumber) && idNumber >= 0
            ? idNumber
            : null,
        id: jsonValuePreview(slot.id) ?? "-",
        busy: slot.is_processing === true,
        taskId: formatInteger(numberValue(slot.id_task)) ?? "-",
        nCtx: formatInteger(numberValue(slot.n_ctx)) ?? "-",
        decoded: formatInteger(numberValue(nextToken?.n_decoded)) ?? "-",
        remain: formatInteger(numberValue(nextToken?.n_remain)) ?? "-",
        promptTokens: formatInteger(numberValue(slot.n_prompt_tokens)) ?? "-",
        promptProcessed:
          formatInteger(numberValue(slot.n_prompt_tokens_processed)) ?? "-",
        promptCache:
          formatInteger(numberValue(slot.n_prompt_tokens_cache)) ?? "-",
        speculative: slot.speculative === true,
      };
    });
}

export type SlotRow = ReturnType<typeof slotRowsFromProbe>[number];

export function slotFilenameBase(model: string | null, slotId: string) {
  const base = (model ?? "llama")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return `${base || "llama"}-s${slotId}.bin`;
}

function metricValue(body: unknown, name: string) {
  if (typeof body !== "string") {
    return null;
  }
  const match = body.match(
    new RegExp(`^${escapeRegExp(name)}\\s+(-?\\d+(?:\\.\\d+)?)$`, "m"),
  );
  return match ? numberValue(match[1]) : null;
}

function formatRate(value: number | null) {
  if (value === null) return null;
  return `${value.toFixed(value >= 10 ? 1 : 2)}/s`;
}

export function metricsRuntimeSummary(probe: EndpointProbe | undefined) {
  if (!probe) return "not probed";
  if (!probe.ok) return endpointErrorText(probe) ?? "unavailable";

  const promptRate = metricValue(probe.body, "llamacpp:prompt_tokens_seconds");
  const generationRate = metricValue(
    probe.body,
    "llamacpp:predicted_tokens_seconds",
  );
  const processing = metricValue(probe.body, "llamacpp:requests_processing");
  const deferred = metricValue(probe.body, "llamacpp:requests_deferred");

  return (
    [
      generationRate !== null ? `gen ${formatRate(generationRate)}` : null,
      promptRate !== null ? `prompt ${formatRate(promptRate)}` : null,
      processing !== null ? `${formatInteger(processing)} active` : null,
      deferred !== null && deferred > 0
        ? `${formatInteger(deferred)} queued`
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || "no metrics"
  );
}

export function loraAdaptersFromProbe(probe: EndpointProbe | undefined) {
  if (!Array.isArray(probe?.body)) {
    return [];
  }
  return probe.body
    .map((item) => objectRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

export function loraRuntimeSummary(probe: EndpointProbe | undefined) {
  if (!probe) return "not probed";
  if (!probe.ok) return endpointErrorText(probe) ?? "unavailable";

  const adapters = loraAdaptersFromProbe(probe);
  const enabled = adapters.filter((adapter) => {
    const scale = numberValue(adapter.scale);
    return scale !== null && scale > 0;
  }).length;

  if (adapters.length === 0) {
    return "no adapters";
  }
  return `${adapters.length} adapter${adapters.length === 1 ? "" : "s"} · ${enabled} enabled`;
}

export function isStartupStatus(
  status: InstanceHealthSummary["status"] | undefined,
) {
  return status === "starting" || status === "loading";
}
