import {
  InstanceArgsSchema,
  KTRANSFORMERS_RESERVED_ARG_KEYS,
  RPC_SERVER_SUPPORTED_FLAGS,
  argumentDefaultsForKind,
  engineDescriptor,
  ggufModelRole,
  ggufPoolingTypeLabel,
  impliedInstanceModelId,
  isDraftGgufArtifactKind,
  SGLANG_MODEL_ARG_KEYS,
  sglangModelArg,
  stripGgufSuffix,
  pathCatalogBinaryEngineKind,
  type ApiProxyReasoningOverride,
  type Instance,
  type InstanceCreate,
  type InstanceKind,
  type InstanceEvictionPolicy,
  type InstancePreflightPreview,
  type InstanceUpdate,
  type ArgumentOption,
  type MemoryEstimate,
  type KTransformersMethod,
  type RpcWorkerRef,
} from "@arriero/core";
import { useForm } from "@mantine/form";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  bindInstanceMemoryAssessment,
  createInstance,
  estimateInstanceMemory,
  getApiProxyConfig,
  getDefaultLlamaServerBinary,
  getLlamaArgumentDefaults,
  getLlamaArguments,
  getResources,
  getSystemResources,
  listPathCatalog,
  listPresets,
  listRpcWorkerCandidates,
  previewInstancePreflight,
  startInstance,
  startRpcWorker,
  updateApiProxyModel,
  updateApiProxyTarget,
  updateInstance,
} from "../../api/client";
import { useScannedModels } from "../hooks/use-scanned-models";
import {
  computeInstanceProxyBindings,
  runProxyCascade,
} from "../proxy/instance-refs";
import { createUiId } from "../utils/id";
import { invalidateInstanceQueries } from "../utils/instance-queries";
import { formatMemoryPoolName } from "../utils/pools";
import {
  compareModelTitles,
  formatBytes,
  instanceNameFromModelPath,
  isVocabModel,
  modelTitle,
  pathBaseName,
} from "../utils/models";
import {
  type ArgRow,
  argsToRows,
  canonicalOptionForRow,
  defaultRows,
  defaultValueForArgument,
  removeArgRow,
  removeArgRows,
  rowValue,
  rowsToArgsWithCatalog,
  upsertArgRow,
} from "./InstanceArgumentRows";
import {
  argString,
  envRowsToRecord,
  hasConfiguredArg,
  hasModelSource,
  hasOwnKey,
  hasSpecConfig,
  isManagedArgRow,
  duplicateInstanceName,
  instanceNameFromHfRepo,
  isSecretEnvKey,
  isSelectableInstanceArgument,
  launchModeFromArgs,
  MANAGED_ENV_KEYS,
  instancePort,
  nextAvailablePort,
  parseEnvJson,
  pythonEngineDefaultRows,
  RPC_WORKER_DEFAULT_PORT,
  presetNameFromPath,
  splitCudaVisibleDevices,
  SPEC_ADVANCED_KEYS,
  SPEC_DRAFT_HF_KEY,
  SPEC_DRAFT_MODEL_KEY,
  SPEC_KEYS,
  SPEC_TYPE_KEY,
  type DraftSource,
  type EnvRow,
  type LaunchMode,
  type RemoteSource,
} from "./instance-form-helpers";
import {
  type MemoryDraftRow,
  memoryDrawsFromRows,
  memoryRowsFromDraws,
} from "./instance-form-memory";
import {
  setDefaultActiveRows,
  setDefaultValueRows,
} from "./instance-form-arg-rows";

export type InstanceFormInitialModel = {
  path: string;
  format: "gguf" | "safetensors";
};

export type InstanceFormModalProps = {
  opened: boolean;
  onClose: () => void;
  instances: Instance[];
  onSaved?: (instance: Instance) => void;
  onLaunchStarted?: (instance: Instance, source: "create") => void;
  instance?: Instance | null;
  duplicateFrom?: Instance | null;
  initialModel?: InstanceFormInitialModel | null;
};

const RPC_WORKER_ARG_KEYS = new Set(
  RPC_SERVER_SUPPORTED_FLAGS.flatMap((flag) => [flag.long, flag.short]),
);
const KTRANSFORMERS_MANAGED_ARG_KEYS = new Set<string>(
  KTRANSFORMERS_RESERVED_ARG_KEYS,
);

function encodeRpcWorkerRef(
  ref: Pick<RpcWorkerRef, "nodeId" | "instanceName">,
) {
  return `${ref.nodeId ?? ""}:${ref.instanceName}`;
}

function decodeRpcWorkerRef(value: string): RpcWorkerRef {
  const separator = value.indexOf(":");
  const nodeRaw = value.slice(0, separator);
  return {
    nodeId: nodeRaw === "" ? null : nodeRaw,
    instanceName: value.slice(separator + 1),
  };
}

type ModelOption = { value: string; label: string };

function modelOptionsWithCustom(
  options: ModelOption[],
  selectedPath: string | null,
): ModelOption[] {
  return selectedPath &&
    !options.some((option) => option.value === selectedPath)
    ? [
        ...options,
        {
          value: selectedPath,
          label: `${pathBaseName(selectedPath)} · custom path`,
        },
      ]
    : options;
}

export function useInstanceForm(props: InstanceFormModalProps) {
  const queryClient = useQueryClient();
  const [argRows, setArgRows] = useState<ArgRow[]>(defaultRows());
  const initializedFormKeyRef = useRef<string | null>(null);
  const catalogNormalizedFormKeyRef = useRef<string | null>(null);
  const [initializedFormKey, setInitializedFormKey] = useState<string | null>(
    null,
  );
  const [showDeprecatedArgs, setShowDeprecatedArgs] = useState(false);
  const [showRawArgs, setShowRawArgs] = useState(false);
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);
  const [showEnvRawJson, setShowEnvRawJson] = useState(false);
  const [selectedModelPath, setSelectedModelPath] = useState<string | null>(
    null,
  );
  const [modelReference, setModelReference] = useState("");
  const [ktransformersCpuWeights, setKTransformersCpuWeights] = useState("");
  const [ktransformersMethod, setKTransformersMethod] =
    useState<KTransformersMethod>("FP8");
  const [ktransformersServedModelName, setKTransformersServedModelName] =
    useState("");
  const [evictionPolicy, setEvictionPolicy] =
    useState<InstanceEvictionPolicy>("preemptible");
  const [cwd, setCwd] = useState("");
  const [kind, setKind] = useState<InstanceKind>("llama-server");
  const [rpcWorkers, setRpcWorkers] = useState<RpcWorkerRef[]>([]);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("model");
  const [remoteSource, setRemoteSource] = useState<RemoteSource>("hf");
  const [specEnabled, setSpecEnabled] = useState(false);
  const [specSource, setSpecSource] = useState<DraftSource>("local");
  const [specAdvancedOpen, setSpecAdvancedOpen] = useState(false);
  const [selectedBinaryPathRefId, setSelectedBinaryPathRefId] = useState<
    string | null
  >(null);
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(
    null,
  );
  const [startAfterCreate, setStartAfterCreate] = useState(false);
  const [memoryRows, setMemoryRows] = useState<MemoryDraftRow[]>([]);
  const [numaMode, setNumaMode] = useState<"none" | "bind" | "interleave">(
    "none",
  );
  const [numaBindNode, setNumaBindNode] = useState<number | null>(null);
  const [numaInterleaveNodes, setNumaInterleaveNodes] = useState<number[]>([]);
  const [reasoning, setReasoning] = useState<ApiProxyReasoningOverride | null>(
    null,
  );
  const [renameSkips, setRenameSkips] = useState<Record<string, boolean>>({});
  const derivedNamesRef = useRef<Set<string>>(new Set());
  const form = useForm({
    initialValues: {
      name: "local-router",
      envJson: JSON.stringify({}, null, 2),
    },
    validate: {
      name: (value) =>
        /^[A-Za-z0-9._-]+$/.test(value)
          ? null
          : "Only letters, digits, dot, underscore and hyphen are allowed",
    },
  });
  const isEdit = Boolean(props.instance);
  const isDuplicate = !props.instance && Boolean(props.duplicateFrom);
  const seedInstance = props.instance ?? props.duplicateFrom ?? null;
  const formKey = `${
    props.instance
      ? `edit:${props.instance.name}`
      : props.duplicateFrom
        ? `duplicate:${props.duplicateFrom.name}`
        : "new"
  }:${props.initialModel ? `${props.initialModel.format}:${props.initialModel.path}` : ""}`;
  const resourcesQuery = useQuery({
    queryKey: ["resources"],
    queryFn: getResources,
    enabled: props.opened,
    staleTime: 30_000,
  });
  const memoryPools = resourcesQuery.data?.data.pools ?? [];
  const memoryLedger = resourcesQuery.data?.data.ledger.pools ?? [];
  const memoryPoolOptions = memoryPools.map((pool) => ({
    value: pool.id,
    label: formatMemoryPoolName(pool),
  }));

  function addMemoryRow() {
    setMemoryRows((rows) => [
      ...rows,
      { id: createUiId(), poolId: "", gib: "" },
    ]);
  }

  function updateMemoryRow(
    id: string,
    patch: Partial<Omit<MemoryDraftRow, "id">>,
  ) {
    setMemoryRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  function removeMemoryRow(id: string) {
    setMemoryRows((rows) => rows.filter((row) => row.id !== id));
  }

  const scanned = useScannedModels({
    enabled: props.opened,
  });
  const pathCatalogQuery = useQuery({
    queryKey: ["path-catalog"],
    queryFn: () => listPathCatalog(),
    enabled: props.opened,
    staleTime: 60_000,
  });
  const defaultBinaryQuery = useQuery({
    queryKey: ["build-default-binary"],
    queryFn: getDefaultLlamaServerBinary,
    enabled: props.opened,
    staleTime: 60_000,
  });
  const selectedBinaryPath = useMemo(() => {
    const entry = (pathCatalogQuery.data?.data ?? []).find(
      (item) => item.id === selectedBinaryPathRefId && item.kind === "binary",
    );
    return entry?.path ?? "";
  }, [pathCatalogQuery.data?.data, selectedBinaryPathRefId]);
  const argsCatalogQuery = useQuery({
    queryKey: ["llama-args", selectedBinaryPath, kind],
    queryFn: () => getLlamaArguments(selectedBinaryPath, { kind }),
    enabled:
      props.opened &&
      Boolean(selectedBinaryPath) &&
      engineDescriptor(kind).preflight.argumentCatalogParser !== "none",
    staleTime: 60_000,
    retry: false,
  });
  const systemResourcesQuery = useQuery({
    queryKey: ["system-resources"],
    queryFn: getSystemResources,
    enabled: props.opened,
    staleTime: 10_000,
  });
  const argumentDefaultsQuery = useQuery({
    queryKey: ["llama-arg-defaults"],
    queryFn: getLlamaArgumentDefaults,
    enabled: props.opened,
    staleTime: 60_000,
  });
  const presetsQuery = useQuery({
    queryKey: ["presets"],
    queryFn: listPresets,
    enabled: props.opened,
    staleTime: 60_000,
  });
  const rpcWorkerCandidatesQuery = useQuery({
    queryKey: ["rpc-worker-candidates"],
    queryFn: listRpcWorkerCandidates,
    enabled: props.opened && kind === "llama-server",
    staleTime: 15_000,
  });
  const rpcWorkerCandidates = rpcWorkerCandidatesQuery.data?.data ?? [];
  const rpcWorkerOptions = useMemo(() => {
    const options = rpcWorkerCandidates.map((candidate) => ({
      value: encodeRpcWorkerRef(candidate),
      label: `${candidate.nodeName} / ${candidate.instanceName}${candidate.endpoint ? ` · ${candidate.endpoint}` : ""} · ${candidate.status}`,
    }));
    for (const ref of rpcWorkers) {
      const value = encodeRpcWorkerRef(ref);
      if (!options.some((option) => option.value === value)) {
        options.push({
          value,
          label: `${ref.nodeId ?? "local"} / ${ref.instanceName} · unavailable`,
        });
      }
    }
    return options;
  }, [rpcWorkerCandidates, rpcWorkers]);
  const selectedRpcWorkerValues = useMemo(
    () => rpcWorkers.map(encodeRpcWorkerRef),
    [rpcWorkers],
  );
  const selectedRpcWorkers = useMemo(() => {
    const byKey = new Map(
      rpcWorkerCandidates.map((candidate) => [
        encodeRpcWorkerRef(candidate),
        candidate,
      ]),
    );
    return rpcWorkers.map((ref) => {
      const candidate = byKey.get(encodeRpcWorkerRef(ref));
      return {
        nodeId: ref.nodeId,
        instanceName: ref.instanceName,
        nodeName: candidate?.nodeName ?? ref.nodeId ?? "local",
        status: candidate?.status ?? null,
      };
    });
  }, [rpcWorkers, rpcWorkerCandidates]);
  const downRpcWorkers = selectedRpcWorkers.filter(
    (worker) => worker.status !== null && worker.status !== "running",
  );

  function applyRpcWorkers(values: string[]) {
    setRpcWorkers(values.map(decodeRpcWorkerRef));
  }

  const startRpcWorkersMutation = useMutation({
    mutationFn: () =>
      Promise.all(
        downRpcWorkers.map((worker) =>
          startRpcWorker({
            nodeId: worker.nodeId,
            instanceName: worker.instanceName,
          }),
        ),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["rpc-worker-candidates"] }),
        queryClient.invalidateQueries({
          queryKey: ["instance-preflight-preview"],
        }),
      ]);
      notifications.show({
        title: "Starting rpc workers",
        message: `Requested start for ${downRpcWorkers.length} worker${downRpcWorkers.length === 1 ? "" : "s"}`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Failed to start rpc workers",
        message: (error as Error).message,
      }),
  });
  const instanceDefaultArgs = useMemo(() => {
    const defaults = argumentDefaultsQuery.data?.data;
    return defaults ? argumentDefaultsForKind(defaults, kind) : [];
  }, [argumentDefaultsQuery.data?.data, kind]);

  const argsCatalog = argsCatalogQuery.data?.data;
  const argsCatalogTooltip = argsCatalog
    ? `Reload from binary --help. Catalog has ${argsCatalog.options.length} args, ${argsCatalog.cache.hit ? "cache hit" : "fresh parse"}: ${argsCatalog.binaryPath}`
    : "Reload from binary --help";
  const knownArgs = argsCatalog?.options ?? [];
  const knownArgByName = useMemo(() => {
    const map = new Map<string, ArgumentOption>();
    for (const option of knownArgs) {
      map.set(option.primaryName, option);
      for (const name of option.names) {
        map.set(name, option);
      }
      for (const name of option.compatibility.binaryNames) {
        map.set(name, option);
      }
    }
    return map;
  }, [knownArgs]);
  const defaultOverlay = useMemo(() => {
    const seen = new Set<string>();
    const out: ArgumentOption[] = [];
    for (const item of instanceDefaultArgs) {
      const option = knownArgByName.get(item.key);
      if (!option || seen.has(option.primaryName)) {
        continue;
      }
      seen.add(option.primaryName);
      out.push(option);
    }
    return out;
  }, [instanceDefaultArgs, knownArgByName]);
  const defaultKeySet = useMemo(
    () => new Set(defaultOverlay.map((option) => option.primaryName)),
    [defaultOverlay],
  );
  const visibleKnownArgs = knownArgs.filter(
    (option) =>
      isSelectableInstanceArgument(option) &&
      !(
        kind === "ktransformers" &&
        option.names.some((name) => KTRANSFORMERS_MANAGED_ARG_KEYS.has(name))
      ) &&
      (showDeprecatedArgs || !option.deprecated),
  );
  const visibleArgRows = useMemo(
    () => argRows.filter((row) => !isManagedArgRow(row)),
    [argRows],
  );
  const manualArgRows = useMemo(
    () =>
      visibleArgRows.filter((row) => {
        const option = canonicalOptionForRow(row, knownArgByName);
        return !option || !defaultKeySet.has(option.primaryName);
      }),
    [visibleArgRows, knownArgByName, defaultKeySet],
  );
  const primaryModels = useMemo(
    () =>
      scanned.models
        .filter(
          (model) => model.artifactKind === "model" && !isVocabModel(model),
        )
        .sort(compareModelTitles),
    [scanned.models],
  );
  const draftModels = useMemo(
    () =>
      scanned.models
        .filter(
          (model) =>
            (model.artifactKind === "model" ||
              isDraftGgufArtifactKind(model.artifactKind)) &&
            !isVocabModel(model),
        )
        .sort(compareModelTitles),
    [scanned.models],
  );
  const selectedModel =
    primaryModels.find((model) => model.path === selectedModelPath) ?? null;
  const embeddingHint = useMemo(() => {
    if (!selectedModel) {
      return null;
    }
    const role = ggufModelRole(selectedModel.metadata);
    if (role === "generative") {
      return null;
    }
    const hasArg = (primaryName: string) =>
      argRows.some(
        (row) =>
          canonicalOptionForRow(row, knownArgByName)?.primaryName ===
          primaryName,
      );
    const flag = role === "reranker" ? "--rerank" : "--embedding";
    const satisfied =
      role === "reranker"
        ? hasArg("--rerank")
        : hasArg("--embedding") || hasArg("--rerank");
    return {
      role,
      flag,
      satisfied,
      pooling: ggufPoolingTypeLabel(selectedModel.metadata.poolingType),
    };
  }, [selectedModel, argRows, knownArgByName]);
  const safetensorsPathOptions = useMemo(
    () => scanned.safetensors.map((model) => model.path),
    [scanned.safetensors],
  );

  const selectableModelOptions = useMemo(
    () =>
      primaryModels.map((model) => ({
        value: model.path,
        label: `${modelTitle(model)} · ${pathBaseName(model.path)} · ${model.metadata.quantization ?? "unknown"} · ${formatBytes(model.sizeBytes)}`,
      })),
    [primaryModels],
  );
  const selectableDraftModelOptions = useMemo(
    () =>
      draftModels.map((model) => ({
        value: model.path,
        label: `${modelTitle(model)} · ${pathBaseName(model.path)} · ${model.metadata.quantization ?? "unknown"} · ${formatBytes(model.sizeBytes)}`,
      })),
    [draftModels],
  );
  const modelOptions = useMemo(
    () => modelOptionsWithCustom(selectableModelOptions, selectedModelPath),
    [selectableModelOptions, selectedModelPath],
  );
  const binaryCatalogEntries = useMemo(
    () =>
      (pathCatalogQuery.data?.data ?? []).filter(
        (entry) =>
          entry.kind === "binary" &&
          pathCatalogBinaryEngineKind(entry) === kind,
      ),
    [pathCatalogQuery.data?.data, kind],
  );
  const binaryCatalogOptions = useMemo(
    () =>
      binaryCatalogEntries.map((entry) => ({
        value: entry.id,
        label: `${entry.name} · ${pathBaseName(entry.path)}`,
      })),
    [binaryCatalogEntries],
  );
  const presetByName = useMemo(
    () =>
      new Map(
        (presetsQuery.data?.data ?? []).map((summary) => [
          summary.name,
          summary,
        ]),
      ),
    [presetsQuery.data?.data],
  );
  const presetOptions = useMemo(() => {
    const summaries = presetsQuery.data?.data ?? [];
    const options = summaries.map((summary) => ({
      value: summary.name,
      label: `${summary.name}${summary.valid ? "" : " · invalid"} · ${summary.entryCount} models`,
    }));
    if (
      selectedPresetName &&
      !options.some((option) => option.value === selectedPresetName)
    ) {
      options.push({
        value: selectedPresetName,
        label: `${selectedPresetName} · missing file`,
      });
    }
    return options;
  }, [presetsQuery.data?.data, selectedPresetName]);
  const hostValue = rowValue(argRows, "--host") || "127.0.0.1";
  const mmprojValue = rowValue(argRows, "--mmproj");
  const hfRepoValue = rowValue(argRows, "--hf-repo");
  const hfFileValue = rowValue(argRows, "--hf-file");
  const modelUrlValue = rowValue(argRows, "--model-url");
  const mmprojUrlValue = rowValue(argRows, "--mmproj-url");
  const remoteDestinationValue = rowValue(argRows, "--model");
  const specDraftModelValue = rowValue(argRows, SPEC_DRAFT_MODEL_KEY);
  const specDraftHfValue = rowValue(argRows, SPEC_DRAFT_HF_KEY);
  const specTypeValue = rowValue(argRows, SPEC_TYPE_KEY);
  const specTypeOption = knownArgByName.get(SPEC_TYPE_KEY);
  const specTypeOptions = (specTypeOption?.allowedValues ?? []).map(
    (value) => ({
      value,
      label: value,
    }),
  );
  const draftModel =
    draftModels.find((model) => model.path === specDraftModelValue) ?? null;
  const draftVocabHint =
    specSource === "local" && selectedModel && draftModel
      ? {
          ok:
            selectedModel.metadata.vocabularySize ===
              draftModel.metadata.vocabularySize &&
            (isDraftGgufArtifactKind(draftModel.artifactKind) ||
              selectedModel.metadata.architecture ===
                draftModel.metadata.architecture),
          mainArch: selectedModel.metadata.architecture ?? "unknown",
          draftArch: draftModel.metadata.architecture ?? "unknown",
          sidecarKind: isDraftGgufArtifactKind(draftModel.artifactKind)
            ? draftModel.artifactKind
            : null,
        }
      : null;
  const draftModelOptions = useMemo(
    () =>
      modelOptionsWithCustom(selectableDraftModelOptions, specDraftModelValue),
    [selectableDraftModelOptions, specDraftModelValue],
  );
  const portRawValue = rowValue(argRows, "--port");
  const portValue = portRawValue === "" ? "" : Number(portRawValue);
  const threadsRawValue = rowValue(argRows, "--threads");
  const threadsValue = threadsRawValue === "" ? "" : Number(threadsRawValue);
  const deviceValue = rowValue(argRows, "--device");
  const cacheEnabled = argRows.some(
    (row) => row.key === "--cache" || row.key === "-c",
  );
  const envDraft = useMemo(() => {
    try {
      return parseEnvJson(form.values.envJson);
    } catch {
      return null;
    }
  }, [form.values.envJson]);
  const numaNodes = systemResourcesQuery.data?.data.numa.nodes ?? [];
  const numaBind = systemResourcesQuery.data?.data.numa.bind ?? false;
  const numaInterleave =
    systemResourcesQuery.data?.data.numa.interleave ?? false;
  const cudaAccelerators = (
    systemResourcesQuery.data?.data.accelerators ?? []
  ).filter(
    (accelerator) =>
      accelerator.kind === "gpu" && accelerator.vendor === "NVIDIA",
  );
  const cudaVisibleDevices = envDraft?.CUDA_VISIBLE_DEVICES;
  const cudaMode =
    envDraft && hasOwnKey(envDraft, "CUDA_VISIBLE_DEVICES")
      ? cudaVisibleDevices === ""
        ? "none"
        : "specific"
      : "all";
  const selectedCudaDevices = splitCudaVisibleDevices(cudaVisibleDevices);
  const singleCudaAccelerator =
    cudaAccelerators.length === 1 ? cudaAccelerators[0] : null;
  const singleCudaEnabled = singleCudaAccelerator
    ? cudaMode === "all" ||
      selectedCudaDevices.includes(singleCudaAccelerator.id)
    : false;
  const cudaDeviceOptions = useMemo(() => {
    const options = cudaAccelerators.map((accelerator) => ({
      value: accelerator.id,
      label: `GPU ${accelerator.id} · ${accelerator.name}`,
    }));
    for (const id of selectedCudaDevices) {
      if (!options.some((option) => option.value === id)) {
        options.push({ value: id, label: `GPU ${id} · custom` });
      }
    }
    return options;
  }, [cudaAccelerators, selectedCudaDevices]);
  const visibleCudaDeviceIds =
    cudaMode === "all"
      ? cudaAccelerators.map((accelerator) => accelerator.id)
      : selectedCudaDevices;

  function seedArgRows(seed: Instance) {
    const rows = argsToRows(seed.args, knownArgByName);
    const portRaw = rowValue(rows, "--port");
    if (!isDuplicate || portRaw === "") {
      return rows;
    }
    const startPort = instancePort(seed) ?? undefined;
    return upsertArgRow(
      rows,
      "--port",
      String(nextAvailablePort(props.instances, undefined, startPort)),
      "number",
    );
  }

  useEffect(() => {
    if (!props.opened) {
      initializedFormKeyRef.current = null;
      catalogNormalizedFormKeyRef.current = null;
      setInitializedFormKey(null);
      return;
    }

    if (initializedFormKeyRef.current === formKey) {
      return;
    }
    if (!seedInstance && argumentDefaultsQuery.isLoading) {
      return;
    }
    initializedFormKeyRef.current = formKey;
    setInitializedFormKey(formKey);
    setRenameSkips({});

    if (seedInstance) {
      const modelPath = argString(seedInstance.args, "--model") || null;
      const presetPathValue =
        argString(seedInstance.args, "--models-preset") || null;
      const presetName = presetPathValue
        ? presetNameFromPath(presetPathValue)
        : null;
      const seededName = isDuplicate
        ? duplicateInstanceName(seedInstance.name, props.instances)
        : seedInstance.name;
      const derivedNames = new Set<string>();
      if (modelPath) {
        derivedNames.add(instanceNameFromModelPath(modelPath));
      }
      const hfRepo = argString(seedInstance.args, "--hf-repo") || null;
      const hfName = hfRepo ? instanceNameFromHfRepo(hfRepo) : "";
      if (hfName) {
        derivedNames.add(hfName);
      }
      if (isDuplicate) {
        derivedNames.add(seededName);
      }
      derivedNamesRef.current = derivedNames;
      form.setValues({
        name: seededName,
        envJson: JSON.stringify(seedInstance.env, null, 2),
      });
      setCustomEnvRows(buildEnvRows(seedInstance.env));
      setShowEnvRawJson(false);
      setKind(seedInstance.kind);
      setModelReference(
        seedInstance.engineConfig?.type === "ktransformers"
          ? seedInstance.engineConfig.model
          : seedInstance.kind === "sglang"
            ? (sglangModelArg(seedInstance) ?? "")
            : (seedInstance.positionalArgs?.[0] ?? ""),
      );
      setKTransformersCpuWeights(
        seedInstance.engineConfig?.type === "ktransformers"
          ? seedInstance.engineConfig.cpuWeights
          : "",
      );
      setKTransformersMethod(
        seedInstance.engineConfig?.type === "ktransformers"
          ? seedInstance.engineConfig.method
          : "FP8",
      );
      setKTransformersServedModelName(
        seedInstance.engineConfig?.type === "ktransformers"
          ? (seedInstance.engineConfig.servedModelName ?? "")
          : "",
      );
      setEvictionPolicy(
        seedInstance.scheduling?.evictionPolicy ??
          engineDescriptor(seedInstance.kind).defaultEvictionPolicy,
      );
      setCwd(seedInstance.cwd ?? "");
      setRpcWorkers(seedInstance.rpcWorkers);
      setSelectedBinaryPathRefId(seedInstance.binaryPathRefId);
      setSelectedModelPath(modelPath);
      setSelectedPresetName(presetName);
      const mode = launchModeFromArgs(seedInstance.args);
      setLaunchMode(mode);
      if (mode === "remote") {
        setRemoteSource(
          hasConfiguredArg(seedInstance.args, "--model-url") ? "url" : "hf",
        );
      }
      setSpecEnabled(hasSpecConfig(seedInstance.args));
      setSpecSource(
        hasConfiguredArg(seedInstance.args, SPEC_DRAFT_HF_KEY) ? "hf" : "local",
      );
      setSpecAdvancedOpen(
        SPEC_ADVANCED_KEYS.some((key) =>
          hasConfiguredArg(seedInstance.args, key),
        ),
      );
      setStartAfterCreate(false);
      setArgRows(
        seedInstance.kind === "sglang"
          ? removeArgRows(seedArgRows(seedInstance), [...SGLANG_MODEL_ARG_KEYS])
          : seedArgRows(seedInstance),
      );
      setMemoryRows(memoryRowsFromDraws(seedInstance.memory));
      const numa = seedInstance.numa;
      setNumaMode(numa?.mode ?? "none");
      setNumaBindNode(numa?.mode === "bind" ? numa.node : null);
      setNumaInterleaveNodes(numa?.mode === "interleave" ? numa.nodes : []);
      setReasoning(seedInstance.reasoning ?? null);
    } else {
      const safetensorsPath =
        props.initialModel?.format === "safetensors"
          ? props.initialModel.path
          : null;
      const modelPath =
        props.initialModel?.format === "gguf" ? props.initialModel.path : null;
      const seedPath = safetensorsPath ?? modelPath;
      const seedKind = safetensorsPath ? "vllm" : "llama-server";
      derivedNamesRef.current = new Set(
        seedPath ? [instanceNameFromModelPath(seedPath)] : [],
      );
      form.setValues({
        name: seedPath ? instanceNameFromModelPath(seedPath) : "local-server",
        envJson: JSON.stringify({}, null, 2),
      });
      setCustomEnvRows([]);
      setShowEnvRawJson(false);
      setKind(seedKind);
      setModelReference(safetensorsPath ?? "");
      setKTransformersCpuWeights("");
      setKTransformersMethod("FP8");
      setKTransformersServedModelName("");
      setEvictionPolicy(engineDescriptor(seedKind).defaultEvictionPolicy);
      setCwd("");
      setRpcWorkers([]);
      setSelectedBinaryPathRefId(null);
      setSelectedModelPath(modelPath);
      setSelectedPresetName(null);
      setLaunchMode("model");
      setRemoteSource("hf");
      setSpecEnabled(false);
      setSpecSource("local");
      setSpecAdvancedOpen(false);
      setStartAfterCreate(false);
      if (safetensorsPath) {
        setArgRows(pythonEngineDefaultRows("vllm", props.instances));
      } else {
        setArgRows(
          defaultRows(
            modelPath ?? undefined,
            nextAvailablePort(props.instances),
          ),
        );
      }
      setMemoryRows([]);
      setNumaMode("none");
      setNumaBindNode(null);
      setNumaInterleaveNodes([]);
      setReasoning(null);
    }
  }, [argumentDefaultsQuery.isLoading, props.opened, formKey]);

  useEffect(() => {
    if (!props.opened || !seedInstance || knownArgByName.size === 0) {
      return;
    }
    if (
      initializedFormKeyRef.current !== formKey ||
      catalogNormalizedFormKeyRef.current === formKey
    ) {
      return;
    }
    catalogNormalizedFormKeyRef.current = formKey;
    setArgRows(seedArgRows(seedInstance));
  }, [props.opened, seedInstance, formKey, knownArgByName]);

  useEffect(() => {
    if (
      !props.opened ||
      seedInstance ||
      selectedBinaryPathRefId ||
      binaryCatalogEntries.length === 0 ||
      defaultBinaryQuery.isLoading
    ) {
      return;
    }
    const defaultRefId = defaultBinaryQuery.data?.data.refId ?? null;
    const preferred =
      binaryCatalogEntries.find((entry) => entry.id === defaultRefId) ??
      binaryCatalogEntries[0];
    if (preferred) {
      setSelectedBinaryPathRefId(preferred.id);
    }
  }, [
    props.opened,
    seedInstance,
    selectedBinaryPathRefId,
    binaryCatalogEntries,
    defaultBinaryQuery.data?.data.refId,
    defaultBinaryQuery.isLoading,
  ]);

  function serializeInstanceInput(values: typeof form.values): InstanceCreate {
    if (!selectedBinaryPathRefId) {
      throw new Error("Select a binary from the catalog");
    }
    if (kind === "ktransformers" && numaMode === "interleave") {
      throw new Error(
        "KTransformers owns internal NUMA placement; manager interleave is unavailable",
      );
    }
    const numa =
      numaMode === "bind" && numaBindNode !== null
        ? ({ mode: "bind", node: numaBindNode } as const)
        : numaMode === "interleave"
          ? ({ mode: "interleave", nodes: numaInterleaveNodes } as const)
          : undefined;
    const cwdValue = cwd.trim();
    const common = {
      name: values.name,
      kind,
      rpcWorkers: [] as RpcWorkerRef[],
      binaryPathRefId: selectedBinaryPathRefId,
      env: parseEnvJson(values.envJson),
      memory: memoryDrawsFromRows(memoryRows),
      scheduling: { evictionPolicy },
      ...(cwdValue ? { cwd: cwdValue } : {}),
      ...(numa ? { numa } : {}),
      ...(reasoning ? { reasoning } : {}),
    };

    if (kind === "rpc-worker") {
      const workerRows = argRows.filter((row) =>
        RPC_WORKER_ARG_KEYS.has(row.key),
      );
      return {
        ...common,
        args: InstanceArgsSchema.parse(
          rowsToArgsWithCatalog(workerRows, knownArgByName),
        ),
      };
    }

    const args = InstanceArgsSchema.parse(
      rowsToArgsWithCatalog(argRows, knownArgByName),
    );
    if (kind === "vllm" || kind === "sglang") {
      const model = modelReference.trim();
      if (!model) {
        throw new Error("Set a Hugging Face model id or local model path");
      }
      return {
        ...common,
        ...(kind === "vllm"
          ? { positionalArgs: [model], args }
          : {
              args: InstanceArgsSchema.parse({
                ...args,
                [SGLANG_MODEL_ARG_KEYS[0]]: model,
              }),
            }),
      };
    }

    if (kind === "ktransformers") {
      const model = modelReference.trim();
      const cpuWeights = ktransformersCpuWeights.trim();
      if (!model) {
        throw new Error("Set a Hugging Face model id or local model path");
      }
      if (!cpuWeights) {
        throw new Error("Set the KTransformers CPU weights path");
      }
      return {
        ...common,
        args,
        engineConfig: {
          type: "ktransformers",
          model,
          cpuWeights,
          method: ktransformersMethod,
          ...(ktransformersServedModelName.trim()
            ? { servedModelName: ktransformersServedModelName.trim() }
            : {}),
        },
      };
    }

    if (launchMode === "router" && !selectedPresetName) {
      throw new Error("Router preset is not selected");
    }
    const llamaRows =
      launchMode === "router"
        ? removeArgRows(argRows, [
            "--model",
            "--hf-repo",
            "--hf-file",
            "--model-url",
            "--mmproj-url",
          ])
        : removeArgRows(argRows, [
            "--models-preset",
            "--models-max",
            "--models-autoload",
            "--no-models-autoload",
          ]);
    const llamaArgs = InstanceArgsSchema.parse(
      rowsToArgsWithCatalog(llamaRows, knownArgByName),
    );
    if (launchMode !== "router" && !hasModelSource(llamaArgs)) {
      throw new Error(
        "Select a model or configure --hf-repo/--model-url before creating the instance",
      );
    }
    return {
      ...common,
      rpcWorkers,
      args: llamaArgs,
    };
  }

  const draftPreview = useMemo(() => {
    try {
      const input: InstancePreflightPreview = serializeInstanceInput(
        form.values,
      );
      return { input, error: null };
    } catch (error) {
      return { input: null, error: (error as Error).message };
    }
  }, [
    argRows,
    form.values.envJson,
    form.values.name,
    kind,
    evictionPolicy,
    ktransformersCpuWeights,
    ktransformersMethod,
    ktransformersServedModelName,
    knownArgByName,
    memoryRows,
    modelReference,
    props.instance?.name,
    rpcWorkers,
    selectedBinaryPathRefId,
    launchMode,
    selectedPresetName,
    numaMode,
    numaBindNode,
    numaInterleaveNodes,
  ]);

  const [debouncedPreflightInput] = useDebouncedValue(draftPreview.input, 350);
  const preflightPreviewQuery = useQuery({
    queryKey: ["instance-preflight-preview", debouncedPreflightInput],
    queryFn: ({ signal }) =>
      previewInstancePreflight(debouncedPreflightInput!, signal),
    enabled: props.opened && Boolean(debouncedPreflightInput),
    staleTime: 1_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const proxyConfigQuery = useQuery({
    queryKey: ["api-proxy-config"],
    queryFn: getApiProxyConfig,
    enabled: props.opened && isEdit,
  });

  const proxyBindings = useMemo(() => {
    const instance = props.instance;
    const proxyConfig = proxyConfigQuery.data?.data;
    if (!instance || !proxyConfig) {
      return null;
    }
    return computeInstanceProxyBindings(instance.name, proxyConfig);
  }, [props.instance, proxyConfigQuery.data?.data]);

  const renameCascade = useMemo(() => {
    const instance = props.instance;
    if (!instance) {
      return null;
    }
    const nextName = form.values.name.trim();
    const nameChanged = Boolean(nextName) && nextName !== instance.name;
    const oldImpliedDefault = stripGgufSuffix(
      impliedInstanceModelId(instance) ?? instance.name,
    );
    const oldDefaults = new Set([oldImpliedDefault, instance.name]);
    const newImplied = draftPreview.input
      ? impliedInstanceModelId(draftPreview.input)
      : null;
    const newDefault = stripGgufSuffix(newImplied ?? nextName);
    const renameTo = (current: string) =>
      current === oldImpliedDefault ? newDefault : nextName;
    const suggestRename = Boolean(nextName) && Boolean(newDefault);
    const renamesFor = <T>(
      items: T[],
      id: (item: T) => string,
      current: (item: T) => string,
    ) =>
      suggestRename
        ? items
            .filter(
              (item) =>
                oldDefaults.has(current(item)) &&
                current(item) !== renameTo(current(item)),
            )
            .map((item) => ({
              id: id(item),
              from: current(item),
              to: renameTo(current(item)),
            }))
        : [];
    const referencingTargets = proxyBindings?.referencingTargets ?? [];
    const targetRenames = renamesFor(
      referencingTargets,
      (target) => target.id,
      (target) => target.name,
    );
    const modelRenames = renamesFor(
      proxyBindings?.boundModels ?? [],
      (model) => model.id,
      (model) => model.modelId,
    );
    if (
      !nameChanged &&
      targetRenames.length === 0 &&
      modelRenames.length === 0
    ) {
      return null;
    }
    return {
      nameChanged,
      instanceStatus: instance.status,
      referencingTargetCount: referencingTargets.length,
      targetRenames,
      modelRenames,
    };
  }, [props.instance, form.values.name, draftPreview.input, proxyBindings]);

  function setRenameSkip(key: string, skip: boolean) {
    setRenameSkips((current) => ({ ...current, [key]: skip }));
  }

  const estimateArgs = draftPreview.input?.args ?? null;
  const estimateArgsKey = draftPreview.input
    ? JSON.stringify({
        kind: draftPreview.input.kind,
        binaryPathRefId: selectedBinaryPathRefId,
        args: draftPreview.input.args,
        positionalArgs: draftPreview.input.positionalArgs,
        env: draftPreview.input.env,
        rpcWorkers: draftPreview.input.rpcWorkers,
      })
    : null;
  const canEstimateMemory = Boolean(
    draftPreview.input &&
    engineDescriptor(kind).estimator !== "none" &&
    (kind === "vllm"
      ? modelReference.trim()
      : estimateArgs &&
        typeof estimateArgs["--model"] === "string" &&
        estimateArgs["--model"]),
  );
  const [memoryEstimate, setMemoryEstimate] = useState<{
    modelPath: string;
    estimate: MemoryEstimate;
    assessmentId: string | null;
  } | null>(null);

  useEffect(() => {
    setMemoryEstimate(null);
  }, [estimateArgsKey]);

  const memoryEstimateMutation = useMutation({
    mutationFn: () => {
      if (!estimateArgs) {
        throw new Error("Configure a model before estimating memory");
      }
      return estimateInstanceMemory({
        kind,
        binaryPathRefId: selectedBinaryPathRefId || undefined,
        args: estimateArgs,
        positionalArgs: draftPreview.input?.positionalArgs,
        env: draftPreview.input?.env,
        rpcWorkers: draftPreview.input?.rpcWorkers,
      });
    },
    onSuccess: (result) => setMemoryEstimate(result.data),
  });

  function runMemoryEstimate() {
    memoryEstimateMutation.mutate();
  }

  function applyEstimateAsDraws() {
    if (memoryEstimate) {
      setMemoryRows(memoryRowsFromDraws(memoryEstimate.estimate.draws));
    }
  }

  function applyLaunchMode(mode: LaunchMode) {
    setLaunchMode(mode);
    if (mode === "model") {
      setSelectedPresetName(null);
      setArgRows((rows) =>
        removeArgRows(rows, [
          "--models-preset",
          "--models-max",
          "--models-autoload",
          "--no-models-autoload",
          "--hf-repo",
          "--hf-file",
          "--model-url",
          "--mmproj-url",
        ]),
      );
      return;
    }
    if (mode === "remote") {
      setSelectedPresetName(null);
      setSelectedModelPath(null);
      setArgRows((rows) =>
        removeArgRows(rows, [
          "--model",
          "--mmproj",
          "--models-preset",
          "--models-max",
          "--models-autoload",
          "--no-models-autoload",
        ]),
      );
      return;
    }

    applyPresetSelection(selectedPresetName);
  }

  function applyBinaryPathRef(refId: string | null) {
    setSelectedBinaryPathRefId(refId);
  }

  function applyKind(next: InstanceKind) {
    setKind(next);
    setEvictionPolicy(engineDescriptor(next).defaultEvictionPolicy);
    const matchingBinaries = (pathCatalogQuery.data?.data ?? []).filter(
      (entry) =>
        entry.kind === "binary" && pathCatalogBinaryEngineKind(entry) === next,
    );
    if (
      !matchingBinaries.some((entry) => entry.id === selectedBinaryPathRefId)
    ) {
      setSelectedBinaryPathRefId(matchingBinaries[0]?.id ?? null);
    }
    if (next === "rpc-worker") {
      setSelectedModelPath(null);
      setSelectedPresetName(null);
      setLaunchMode("model");
      setArgRows((rows) => {
        const kept = rows.filter((row) => RPC_WORKER_ARG_KEYS.has(row.key));
        const withHost = upsertArgRow(kept, "--host", "0.0.0.0", "string");
        return upsertArgRow(
          withHost,
          "--port",
          String(
            nextAvailablePort(
              props.instances,
              props.instance?.name,
              RPC_WORKER_DEFAULT_PORT,
            ),
          ),
          "number",
        );
      });
      return;
    }
    if (next === "vllm" || next === "sglang") {
      setSelectedModelPath(null);
      setSelectedPresetName(null);
      setRpcWorkers([]);
      setLaunchMode("model");
      setArgRows(
        pythonEngineDefaultRows(next, props.instances, props.instance?.name),
      );
      return;
    }
    if (next === "ktransformers") {
      setSelectedModelPath(null);
      setSelectedPresetName(null);
      setRpcWorkers([]);
      setLaunchMode("model");
      setNumaMode((mode) => (mode === "interleave" ? "none" : mode));
      const recommendedPools = [
        memoryPools.find((pool) => pool.kind === "host"),
        memoryPools.find(
          (pool) =>
            pool.kind === "gpu" &&
            (cudaAccelerators[0]
              ? pool.deviceRef === cudaAccelerators[0].id
              : true),
        ),
      ].filter((pool) => pool !== undefined);
      setMemoryRows(
        recommendedPools.map((pool) => ({
          id: createUiId(),
          poolId: pool.id,
          gib: "",
        })),
      );
      setArgRows(
        pythonEngineDefaultRows(
          "ktransformers",
          props.instances,
          props.instance?.name,
        ),
      );
      return;
    }
    setArgRows((rows) => {
      const withHost = upsertArgRow(rows, "--host", "127.0.0.1", "string");
      return upsertArgRow(
        withHost,
        "--port",
        String(nextAvailablePort(props.instances, props.instance?.name)),
        "number",
      );
    });
  }

  function defaultRowActive(option: ArgumentOption) {
    const row = argRows.find(
      (item) =>
        canonicalOptionForRow(item, knownArgByName)?.primaryName ===
        option.primaryName,
    );
    return Boolean(row) && row?.valueType !== "null";
  }

  function defaultRowValue(option: ArgumentOption) {
    const row = argRows.find(
      (item) =>
        canonicalOptionForRow(item, knownArgByName)?.primaryName ===
        option.primaryName,
    );
    return row?.value ?? defaultValueForArgument(option);
  }

  function setDefaultActive(option: ArgumentOption, active: boolean) {
    setArgRows((rows) =>
      setDefaultActiveRows(rows, option, knownArgByName, active),
    );
  }

  function setDefaultValue(option: ArgumentOption, value: string) {
    setArgRows((rows) =>
      setDefaultValueRows(rows, option, knownArgByName, value),
    );
  }

  function applyPresetSelection(presetName: string | null) {
    setLaunchMode("router");
    setSelectedPresetName(presetName);
    setSelectedModelPath(null);
    setSpecEnabled(false);
    setSpecAdvancedOpen(false);
    const presetFilePath = presetName
      ? (presetByName.get(presetName)?.path ?? "")
      : "";
    setArgRows((rows) => {
      let next = removeArgRows(rows, [
        "--model",
        "--mmproj",
        "--hf-repo",
        "--hf-file",
        "--model-url",
        "--mmproj-url",
        ...SPEC_KEYS,
      ]);
      next =
        presetName && presetFilePath
          ? upsertArgRow(next, "--models-preset", presetFilePath, "string")
          : removeArgRow(next, "--models-preset");
      if (presetName && !rowValue(next, "--models-max")) {
        next = upsertArgRow(next, "--models-max", "4", "number");
      }
      if (
        presetName &&
        !rowValue(next, "--models-autoload") &&
        !rowValue(next, "--no-models-autoload")
      ) {
        next = upsertArgRow(next, "--models-autoload", "", "flag");
      }
      return next;
    });
    if (
      !isEdit &&
      presetName &&
      (!form.values.name ||
        form.values.name === "local-server" ||
        form.values.name === "local-router")
    ) {
      form.setFieldValue("name", "local-router");
    }
  }

  function nameFollowsModelSource(current: string): boolean {
    if (!current || current === "local-server" || current === "local-router") {
      return true;
    }
    if (derivedNamesRef.current.has(current)) {
      return true;
    }
    if (
      selectedModelPath &&
      current === instanceNameFromModelPath(selectedModelPath)
    ) {
      return true;
    }
    const hfName = hfRepoValue ? instanceNameFromHfRepo(hfRepoValue) : "";
    return Boolean(hfName) && current === hfName;
  }

  function followName(next: string) {
    derivedNamesRef.current.add(next);
    form.setFieldValue("name", next);
  }

  function applyModelSelection(modelPath: string | null) {
    const modelChanged = modelPath !== selectedModelPath;
    setLaunchMode("model");
    setSelectedModelPath(modelPath);
    setSelectedPresetName(null);
    setArgRows((rows) => {
      let next = modelPath
        ? upsertArgRow(rows, "--model", modelPath, "string")
        : removeArgRow(rows, "--model");
      next = removeArgRows(next, [
        "--models-preset",
        "--models-max",
        "--models-autoload",
        "--no-models-autoload",
        "--hf-repo",
        "--hf-file",
        "--model-url",
        "--mmproj-url",
        ...(modelChanged ? ["--mmproj"] : []),
      ]);
      return next;
    });
    if (modelPath && nameFollowsModelSource(form.values.name)) {
      followName(instanceNameFromModelPath(modelPath));
    }
  }

  function applyEmbeddingFlag() {
    if (!embeddingHint) {
      return;
    }
    const flag = embeddingHint.flag;
    setArgRows((rows) => upsertArgRow(rows, flag, "", "flag"));
  }

  function applySpecArg(
    key: string,
    value: string,
    valueType: ArgRow["valueType"],
  ) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, key, trimmed, valueType)
        : removeArgRow(rows, key),
    );
  }

  function applyRemoteRepo(value: string) {
    applySpecArg("--hf-repo", value, "string");
    const name = instanceNameFromHfRepo(value.trim());
    if (name && nameFollowsModelSource(form.values.name)) {
      followName(name);
    }
  }

  const applyRemoteFile = (value: string) =>
    applySpecArg("--hf-file", value, "string");

  const applyRemoteUrl = (value: string) =>
    applySpecArg("--model-url", value, "string");

  const applyRemoteDestination = (value: string) =>
    applySpecArg("--model", value, "string");

  const applyMmprojSelection = (value: string | null) =>
    applySpecArg("--mmproj", value ?? "", "string");

  const applyMmprojUrl = (value: string) =>
    applySpecArg("--mmproj-url", value, "string");

  function applyRemoteSource(source: RemoteSource) {
    setRemoteSource(source);
    setArgRows((rows) =>
      source === "hf"
        ? removeArgRows(rows, ["--model-url", "--model", "--mmproj-url"])
        : removeArgRows(rows, ["--hf-repo", "--hf-file"]),
    );
  }

  function applySpecEnabled(enabled: boolean) {
    setSpecEnabled(enabled);
    if (!enabled) {
      setArgRows((rows) => removeArgRows(rows, SPEC_KEYS));
      setSpecAdvancedOpen(false);
    }
  }

  function applySpecSource(source: DraftSource) {
    setSpecSource(source);
    setArgRows((rows) =>
      source === "local"
        ? removeArgRow(rows, SPEC_DRAFT_HF_KEY)
        : removeArgRow(rows, SPEC_DRAFT_MODEL_KEY),
    );
  }

  const applySpecDraftModel = (value: string | null) =>
    applySpecArg(SPEC_DRAFT_MODEL_KEY, value ?? "", "string");

  const applySpecDraftHf = (value: string) =>
    applySpecArg(SPEC_DRAFT_HF_KEY, value, "string");

  function applyHfToken(value: string) {
    updateEnvironment((env) => {
      if (value) {
        env.HF_TOKEN = value;
      } else {
        delete env.HF_TOKEN;
      }
      return env;
    });
  }

  const mutation = useMutation({
    mutationFn: async (input: InstanceCreate | InstanceUpdate) => {
      if (props.instance) {
        return updateInstance(
          props.instance.name,
          input.cwd === undefined ? { ...input, cwd: null } : input,
        );
      }
      return createInstance(input as InstanceCreate);
    },
    onSuccess: async (result) => {
      const created = result.data;
      props.onSaved?.(created);
      let proxyRenameFailures: string[] = [];
      if (renameCascade) {
        proxyRenameFailures = await runProxyCascade(
          [
            ...renameCascade.targetRenames.map((item) => ({
              key: `target:${item.id}`,
              label: `target ${item.from}`,
              run: () => updateApiProxyTarget(item.id, { name: item.to }),
            })),
            ...renameCascade.modelRenames.map((item) => ({
              key: `model:${item.id}`,
              label: `model ${item.from}`,
              run: () => updateApiProxyModel(item.id, { modelId: item.to }),
            })),
          ],
          renameSkips,
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["api-proxy-config"] }),
          queryClient.invalidateQueries({
            queryKey: ["api-proxy-target-models"],
          }),
        ]);
      }
      let assessmentWarning: string | null = null;
      if (memoryEstimate?.assessmentId) {
        try {
          await bindInstanceMemoryAssessment(
            created.name,
            memoryEstimate.assessmentId,
          );
        } catch (error) {
          assessmentWarning = (error as Error).message;
        }
      }
      let notification: {
        title: string;
        message: string;
        color?: "yellow" | "red";
      } = {
        title: isEdit ? "Instance updated" : "Instance created",
        message: "Configuration saved",
      };

      if (!isEdit && startAfterCreate) {
        const preview = preflightPreviewQuery.data?.data;
        if (preview && !preview.ok) {
          notification = {
            title: "Instance created",
            message: "Start skipped because preflight has blocking issues",
            color: "yellow",
          };
        } else {
          try {
            await startInstance(created.name);
            props.onLaunchStarted?.(created, "create");
            notification = {
              title: "Instance created and started",
              message: created.name,
            };
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              notification = {
                title: "Instance created",
                message:
                  "Start skipped: not enough memory budget. Start manually to confirm.",
                color: "yellow",
              };
            } else {
              notification = {
                title: "Instance created, start failed",
                message: (error as Error).message,
                color: "red",
              };
            }
          }
        }
      }

      if (assessmentWarning && notification.color !== "red") {
        notification = {
          ...notification,
          color: "yellow",
          message: `${notification.message}. Memory assessment was not attached: ${assessmentWarning}`,
        };
      }

      if (proxyRenameFailures.length > 0 && notification.color !== "red") {
        notification = {
          ...notification,
          color: "yellow",
          message: `${notification.message}. Proxy renames failed: ${proxyRenameFailures.join("; ")}`,
        };
      }

      await invalidateInstanceQueries(queryClient, created.name);
      props.onClose();
      form.reset();
      setArgRows(defaultRows());
      setCustomEnvRows([]);
      setShowEnvRawJson(false);
      setStartAfterCreate(false);
      notifications.show(notification);
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: isEdit ? "Update failed" : "Create failed",
        message: (error as Error).message,
      });
    },
  });

  const refreshArgsMutation = useMutation({
    mutationFn: () =>
      getLlamaArguments(selectedBinaryPath, { kind, refresh: true }),
    onSuccess: (result) => {
      queryClient.setQueryData(
        ["llama-args", selectedBinaryPath, kind],
        result,
      );
      notifications.show({
        title: "Argument catalog refreshed",
        message: `${result.data.options.length} options`,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Argument refresh failed",
        message: (error as Error).message,
      });
    },
  });

  function updateEnvironment(
    mutator: (env: Record<string, string>) => Record<string, string>,
  ) {
    try {
      const current = parseEnvJson(form.values.envJson);
      form.setFieldValue(
        "envJson",
        JSON.stringify(mutator({ ...current }), null, 2),
      );
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Environment JSON is invalid",
        message: (error as Error).message,
      });
    }
  }

  function buildEnvRows(env: Record<string, string>): EnvRow[] {
    return Object.entries(env)
      .filter(([key]) => !MANAGED_ENV_KEYS.has(key))
      .map(([key, value]) => ({ id: createUiId(), key, value }));
  }

  function commitEnvRows(rows: EnvRow[]) {
    updateEnvironment((env) => {
      const next: Record<string, string> = {};
      for (const key of MANAGED_ENV_KEYS) {
        const value = env[key];
        if (value !== undefined) {
          next[key] = value;
        }
      }
      return Object.assign(next, envRowsToRecord(rows));
    });
  }

  function addEnvRow() {
    setCustomEnvRows((rows) => [
      ...rows,
      { id: createUiId(), key: "", value: "" },
    ]);
  }

  function updateEnvRow(
    id: string,
    patch: Partial<Pick<EnvRow, "key" | "value">>,
  ) {
    const next = customEnvRows.map((row) =>
      row.id === id ? { ...row, ...patch } : row,
    );
    setCustomEnvRows(next);
    commitEnvRows(next);
  }

  function removeEnvRow(id: string) {
    const next = customEnvRows.filter((row) => row.id !== id);
    setCustomEnvRows(next);
    commitEnvRows(next);
  }

  function setEnvRawJson(enabled: boolean) {
    if (enabled) {
      setShowEnvRawJson(true);
      return;
    }
    try {
      setCustomEnvRows(buildEnvRows(parseEnvJson(form.values.envJson)));
      setShowEnvRawJson(false);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Environment JSON is invalid",
        message: (error as Error).message,
      });
    }
  }

  function applySingleCudaVisibility(enabled: boolean) {
    updateEnvironment((env) => {
      if (enabled) {
        delete env.CUDA_VISIBLE_DEVICES;
        return env;
      }
      env.CUDA_VISIBLE_DEVICES = "";
      return env;
    });
  }

  function applyCudaDevices(devices: string[]) {
    updateEnvironment((env) => {
      const selected = devices.filter(Boolean);
      const detectedIds = cudaAccelerators.map((accelerator) => accelerator.id);
      const allDetectedSelected =
        detectedIds.length > 0 &&
        selected.length === detectedIds.length &&
        detectedIds.every((id) => selected.includes(id));

      if (selected.length === 0) {
        env.CUDA_VISIBLE_DEVICES = "";
      } else if (allDetectedSelected) {
        delete env.CUDA_VISIBLE_DEVICES;
      } else {
        env.CUDA_VISIBLE_DEVICES = selected.join(",");
      }
      return env;
    });
  }

  function submit(values: typeof form.values) {
    try {
      mutation.mutate(serializeInstanceInput(values));
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Invalid configuration",
        message: (error as Error).message,
      });
    }
  }

  const waitingForInitialDefaults =
    props.opened &&
    !seedInstance &&
    initializedFormKey === null &&
    argumentDefaultsQuery.isLoading;
  const modalTitle = `${isEdit ? "Edit" : isDuplicate ? "Duplicate" : "New"} ${kind} instance`;

  return {
    form,
    isEdit,
    kind,
    setKind,
    applyKind,
    isWorker: kind === "rpc-worker",
    modelSource: engineDescriptor(kind).form.modelSource,
    modelReference,
    setModelReference,
    ktransformersCpuWeights,
    setKTransformersCpuWeights,
    ktransformersMethod,
    setKTransformersMethod,
    ktransformersServedModelName,
    setKTransformersServedModelName,
    evictionPolicy,
    setEvictionPolicy,
    cwd,
    setCwd,
    rpcWorkerOptions,
    selectedRpcWorkerValues,
    selectedRpcWorkers,
    applyRpcWorkers,
    rpcWorkerCandidatesQuery,
    downRpcWorkerCount: downRpcWorkers.length,
    startDownRpcWorkers: () => startRpcWorkersMutation.mutate(),
    startRpcWorkersPending: startRpcWorkersMutation.isPending,
    waitingForInitialDefaults,
    modalTitle,
    argRows,
    setArgRows,
    pathCatalogQuery,
    binaryCatalogOptions,
    selectedBinaryPathRefId,
    applyBinaryPathRef,
    launchMode,
    applyLaunchMode,
    scanned,
    selectedModel,
    selectedModelPath,
    applyModelSelection,
    embeddingHint,
    applyEmbeddingFlag,
    modelOptions,
    safetensorsPathOptions,
    mmprojValue,
    applyMmprojSelection,
    remoteSource,
    applyRemoteSource,
    hfRepoValue,
    applyRemoteRepo,
    hfFileValue,
    applyRemoteFile,
    modelUrlValue,
    applyRemoteUrl,
    remoteDestinationValue,
    applyRemoteDestination,
    mmprojUrlValue,
    applyMmprojUrl,
    envDraft,
    applyHfToken,
    customEnvRows,
    addEnvRow,
    updateEnvRow,
    removeEnvRow,
    showEnvRawJson,
    setEnvRawJson,
    isSecretEnvKey,
    presetsQuery,
    selectedPresetName,
    applyPresetSelection,
    presetOptions,
    hostValue,
    portValue,
    threadsValue,
    deviceValue,
    cacheEnabled,
    specEnabled,
    applySpecEnabled,
    specTypeOptions,
    specTypeValue,
    applySpecArg,
    specSource,
    applySpecSource,
    specDraftModelValue,
    applySpecDraftModel,
    specDraftHfValue,
    applySpecDraftHf,
    draftVocabHint,
    specAdvancedOpen,
    setSpecAdvancedOpen,
    draftModelOptions,
    showDeprecatedArgs,
    setShowDeprecatedArgs,
    showRawArgs,
    setShowRawArgs,
    argsCatalogQuery,
    argsCatalogTooltip,
    visibleKnownArgs,
    knownArgByName,
    refreshArgsMutation,
    defaultOverlay,
    defaultRowValue,
    defaultRowActive,
    setDefaultActive,
    setDefaultValue,
    manualArgRows,
    draftPreview,
    preflightPreviewQuery,
    cudaAccelerators,
    singleCudaAccelerator,
    singleCudaEnabled,
    applySingleCudaVisibility,
    visibleCudaDeviceIds,
    applyCudaDevices,
    cudaDeviceOptions,
    cudaMode,
    selectedCudaDevices,
    mutation,
    startAfterCreate,
    setStartAfterCreate,
    numaNodes,
    numaBind,
    numaInterleave,
    numaMode,
    setNumaMode,
    numaBindNode,
    setNumaBindNode,
    numaInterleaveNodes,
    setNumaInterleaveNodes,
    reasoning,
    setReasoning,
    memoryRows,
    memoryPoolOptions,
    memoryLedger,
    resourcesQuery,
    addMemoryRow,
    updateMemoryRow,
    removeMemoryRow,
    canEstimateMemory,
    memoryEstimate,
    runMemoryEstimate,
    applyEstimateAsDraws,
    memoryEstimatePending: memoryEstimateMutation.isPending,
    memoryEstimateError: memoryEstimateMutation.isError
      ? ((memoryEstimateMutation.error as Error)?.message ??
        "Failed to estimate memory")
      : null,
    renameCascade,
    renameSkips,
    setRenameSkip,
    submit,
  };
}

export type InstanceFormController = ReturnType<typeof useInstanceForm>;
