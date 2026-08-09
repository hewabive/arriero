import {
  InstanceArgsSchema,
  KTRANSFORMERS_RESERVED_ARG_KEYS,
  RPC_SERVER_SUPPORTED_FLAGS,
  engineDescriptor,
  ggufModelRole,
  ggufPoolingTypeLabel,
  impliedInstanceModelId,
  pathCatalogBinaryEngineKind,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { computeProxyUsage, type ProxyUsageRef } from "../proxy/usage";
import { createUiId } from "../utils/id";
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
  nextAvailablePort,
  parseEnvJson,
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

export type InstanceFormModalProps = {
  opened: boolean;
  onClose: () => void;
  instances: Instance[];
  onSaved?: (instance: Instance) => void;
  onLaunchStarted?: (instance: Instance, source: "create") => void;
  instance?: Instance | null;
  duplicateFrom?: Instance | null;
  initialModelPath?: string | null;
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
  }:${props.initialModelPath ?? ""}`;
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
  const instanceDefaultArgs = useMemo(
    () => argumentDefaultsQuery.data?.data.instance ?? [],
    [argumentDefaultsQuery.data?.data.instance],
  );

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
  const selectableModels = useMemo(
    () =>
      scanned.models
        .filter((model) => !model.isMmproj && !isVocabModel(model))
        .sort(compareModelTitles),
    [scanned.models],
  );
  const selectedModel =
    selectableModels.find((model) => model.path === selectedModelPath) ?? null;
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
  const modelOptions = useMemo(() => {
    const options = selectableModels.map((model) => ({
      value: model.path,
      label: `${modelTitle(model)} · ${pathBaseName(model.path)} · ${model.metadata.quantization ?? "unknown"} · ${formatBytes(model.sizeBytes)}`,
    }));
    if (
      selectedModelPath &&
      !options.some((option) => option.value === selectedModelPath)
    ) {
      options.push({
        value: selectedModelPath,
        label: `${pathBaseName(selectedModelPath)} · custom path`,
      });
    }
    return options;
  }, [selectableModels, selectedModelPath]);
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
    selectableModels.find((model) => model.path === specDraftModelValue) ??
    null;
  const draftVocabHint =
    specSource === "local" && selectedModel && draftModel
      ? {
          ok:
            selectedModel.metadata.architecture ===
              draftModel.metadata.architecture &&
            selectedModel.metadata.vocabularySize ===
              draftModel.metadata.vocabularySize,
          mainArch: selectedModel.metadata.architecture ?? "unknown",
          draftArch: draftModel.metadata.architecture ?? "unknown",
        }
      : null;
  const draftModelOptions = useMemo(() => {
    const options = selectableModels.map((model) => ({
      value: model.path,
      label: `${modelTitle(model)} · ${pathBaseName(model.path)} · ${model.metadata.quantization ?? "unknown"} · ${formatBytes(model.sizeBytes)}`,
    }));
    if (
      specDraftModelValue &&
      !options.some((option) => option.value === specDraftModelValue)
    ) {
      options.push({
        value: specDraftModelValue,
        label: `${pathBaseName(specDraftModelValue)} · custom path`,
      });
    }
    return options;
  }, [selectableModels, specDraftModelValue]);
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
    const sourcePort = Number(portRaw);
    const startPort =
      Number.isInteger(sourcePort) && sourcePort > 0 && sourcePort <= 65535
        ? sourcePort
        : undefined;
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
      setArgRows(seedArgRows(seedInstance));
      setMemoryRows(memoryRowsFromDraws(seedInstance.memory));
      const numa = seedInstance.numa;
      setNumaMode(numa?.mode ?? "none");
      setNumaBindNode(numa?.mode === "bind" ? numa.node : null);
      setNumaInterleaveNodes(numa?.mode === "interleave" ? numa.nodes : []);
    } else {
      const modelPath = props.initialModelPath ?? null;
      const port = nextAvailablePort(props.instances);
      derivedNamesRef.current = new Set(
        modelPath ? [instanceNameFromModelPath(modelPath)] : [],
      );
      form.setValues({
        name: modelPath ? instanceNameFromModelPath(modelPath) : "local-server",
        envJson: JSON.stringify({}, null, 2),
      });
      setCustomEnvRows([]);
      setShowEnvRawJson(false);
      setKind("llama-server");
      setModelReference("");
      setKTransformersCpuWeights("");
      setKTransformersMethod("FP8");
      setKTransformersServedModelName("");
      setEvictionPolicy(engineDescriptor("llama-server").defaultEvictionPolicy);
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
      setArgRows(defaultRows(modelPath ?? undefined, port));
      setMemoryRows([]);
      setNumaMode("none");
      setNumaBindNode(null);
      setNumaInterleaveNodes([]);
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
    const env = parseEnvJson(values.envJson);
    const memory = memoryDrawsFromRows(memoryRows);
    const scheduling = { evictionPolicy };

    if (kind === "rpc-worker") {
      const workerRows = argRows.filter((row) =>
        RPC_WORKER_ARG_KEYS.has(row.key),
      );
      return {
        name: values.name,
        kind,
        rpcWorkers: [],
        binaryPathRefId: selectedBinaryPathRefId,
        args: InstanceArgsSchema.parse(
          rowsToArgsWithCatalog(workerRows, knownArgByName),
        ),
        env,
        memory,
        scheduling,
        ...(numa ? { numa } : {}),
      };
    }

    const args = InstanceArgsSchema.parse(
      rowsToArgsWithCatalog(argRows, knownArgByName),
    );
    if (kind === "vllm") {
      const model = modelReference.trim();
      if (!model) {
        throw new Error("Set a Hugging Face model id or local model path");
      }
      return {
        name: values.name,
        kind,
        rpcWorkers: [],
        binaryPathRefId: selectedBinaryPathRefId,
        positionalArgs: [model],
        args,
        env,
        memory,
        scheduling,
        ...(numa ? { numa } : {}),
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
        name: values.name,
        kind,
        rpcWorkers: [],
        binaryPathRefId: selectedBinaryPathRefId,
        args,
        env,
        memory,
        engineConfig: {
          type: "ktransformers",
          model,
          cpuWeights,
          method: ktransformersMethod,
          ...(ktransformersServedModelName.trim()
            ? { servedModelName: ktransformersServedModelName.trim() }
            : {}),
        },
        scheduling,
        ...(numa ? { numa } : {}),
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
      name: values.name,
      kind,
      rpcWorkers,
      binaryPathRefId: selectedBinaryPathRefId,
      args: llamaArgs,
      env,
      memory,
      scheduling,
      ...(numa ? { numa } : {}),
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
    retry: false,
  });

  const proxyConfigQuery = useQuery({
    queryKey: ["api-proxy-config"],
    queryFn: getApiProxyConfig,
    enabled: props.opened && isEdit,
  });

  const renameCascade = useMemo(() => {
    const instance = props.instance;
    if (!instance) {
      return null;
    }
    const nextName = form.values.name.trim();
    const nameChanged = Boolean(nextName) && nextName !== instance.name;
    const oldImpliedDefault = (
      impliedInstanceModelId(instance) ?? instance.name
    ).replace(/\.gguf$/i, "");
    const oldDefaults = new Set([oldImpliedDefault, instance.name]);
    const newImplied = draftPreview.input
      ? impliedInstanceModelId(draftPreview.input)
      : null;
    const newDefault = (newImplied ?? nextName).replace(/\.gguf$/i, "");
    const renameTo = (current: string) =>
      current === oldImpliedDefault ? newDefault : nextName;
    const proxyConfig = proxyConfigQuery.data?.data;
    const oldEndpointId = `instance:${instance.name}`;
    const referencingTargets = (proxyConfig?.targets ?? []).filter(
      (target) => target.endpointId === oldEndpointId,
    );
    const referencingTargetIds = new Set(
      referencingTargets.map((target) => target.id),
    );
    const usage = computeProxyUsage(
      proxyConfig?.models ?? [],
      proxyConfig?.pipelines ?? [],
    );
    const referencingModelIds = new Set<string>();
    const pipelineQueue: string[] = [];
    const seenPipelines = new Set<string>();
    const enqueueRefs = (refs: ProxyUsageRef[] | undefined) => {
      for (const ref of refs ?? []) {
        if (ref.kind === "model") {
          referencingModelIds.add(ref.id);
        } else if (!seenPipelines.has(ref.id)) {
          seenPipelines.add(ref.id);
          pipelineQueue.push(ref.id);
        }
      }
    };
    for (const targetId of referencingTargetIds) {
      enqueueRefs(usage.byTargetId.get(targetId));
    }
    while (pipelineQueue.length > 0) {
      enqueueRefs(usage.byPipelineId.get(pipelineQueue.pop()!));
    }
    const referencingModels = (proxyConfig?.models ?? []).filter(
      (model) =>
        referencingModelIds.has(model.id) ||
        (model.routeTo?.type === "endpoint" &&
          model.routeTo.endpointId === oldEndpointId),
    );
    const suggestRename = Boolean(nextName) && Boolean(newDefault);
    const targetRenames = suggestRename
      ? referencingTargets
          .filter(
            (target) =>
              oldDefaults.has(target.name) &&
              target.name !== renameTo(target.name),
          )
          .map((target) => ({
            id: target.id,
            from: target.name,
            to: renameTo(target.name),
          }))
      : [];
    const modelRenames = suggestRename
      ? referencingModels
          .filter(
            (model) =>
              oldDefaults.has(model.modelId) &&
              model.modelId !== renameTo(model.modelId),
          )
          .map((model) => ({
            id: model.id,
            from: model.modelId,
            to: renameTo(model.modelId),
          }))
      : [];
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
  }, [
    props.instance,
    form.values.name,
    draftPreview.input,
    proxyConfigQuery.data?.data,
  ]);

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
    if (next === "vllm") {
      setSelectedModelPath(null);
      setSelectedPresetName(null);
      setRpcWorkers([]);
      setLaunchMode("model");
      setArgRows([
        {
          id: createUiId(),
          key: "--host",
          value: "127.0.0.1",
          valueType: "string",
        },
        {
          id: createUiId(),
          key: "--port",
          value: String(
            nextAvailablePort(
              props.instances,
              props.instance?.name,
              engineDescriptor("vllm").http.defaultPort,
            ),
          ),
          valueType: "number",
        },
      ]);
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
      setArgRows([
        {
          id: createUiId(),
          key: "--host",
          value: "127.0.0.1",
          valueType: "string",
        },
        {
          id: createUiId(),
          key: "--port",
          value: String(
            nextAvailablePort(
              props.instances,
              props.instance?.name,
              engineDescriptor("ktransformers").http.defaultPort,
            ),
          ),
          valueType: "number",
        },
      ]);
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

  function applyRemoteRepo(value: string) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, "--hf-repo", trimmed, "string")
        : removeArgRow(rows, "--hf-repo"),
    );
    const name = instanceNameFromHfRepo(trimmed);
    if (name && nameFollowsModelSource(form.values.name)) {
      followName(name);
    }
  }

  function applyRemoteFile(value: string) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, "--hf-file", trimmed, "string")
        : removeArgRow(rows, "--hf-file"),
    );
  }

  function applyRemoteUrl(value: string) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, "--model-url", trimmed, "string")
        : removeArgRow(rows, "--model-url"),
    );
  }

  function applyRemoteDestination(value: string) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, "--model", trimmed, "string")
        : removeArgRow(rows, "--model"),
    );
  }

  function applyMmprojSelection(value: string | null) {
    const trimmed = (value ?? "").trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, "--mmproj", trimmed, "string")
        : removeArgRow(rows, "--mmproj"),
    );
  }

  function applyMmprojUrl(value: string) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, "--mmproj-url", trimmed, "string")
        : removeArgRow(rows, "--mmproj-url"),
    );
  }

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

  function applySpecDraftModel(value: string | null) {
    const trimmed = (value ?? "").trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, SPEC_DRAFT_MODEL_KEY, trimmed, "string")
        : removeArgRow(rows, SPEC_DRAFT_MODEL_KEY),
    );
  }

  function applySpecDraftHf(value: string) {
    const trimmed = value.trim();
    setArgRows((rows) =>
      trimmed
        ? upsertArgRow(rows, SPEC_DRAFT_HF_KEY, trimmed, "string")
        : removeArgRow(rows, SPEC_DRAFT_HF_KEY),
    );
  }

  function applySpecArg(
    key: string,
    value: string,
    valueType: ArgRow["valueType"],
  ) {
    setArgRows((rows) =>
      value.trim()
        ? upsertArgRow(rows, key, value, valueType)
        : removeArgRow(rows, key),
    );
  }

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

  async function invalidateSavedInstance(id: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["instances"] }),
      queryClient.invalidateQueries({ queryKey: ["instances-health-summary"] }),
      queryClient.invalidateQueries({
        queryKey: ["instance-resource-profiles"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["instance-health-summary", id],
      }),
      queryClient.invalidateQueries({ queryKey: ["instance-runtime", id] }),
      queryClient.invalidateQueries({ queryKey: ["instance-llama", id] }),
      queryClient.invalidateQueries({
        queryKey: ["instance-status-summary", id],
      }),
      queryClient.invalidateQueries({ queryKey: ["instance-logs", id] }),
    ]);
  }

  const mutation = useMutation({
    mutationFn: async (input: InstanceCreate | InstanceUpdate) => {
      if (props.instance) {
        return updateInstance(props.instance.name, input);
      }
      return createInstance(input as InstanceCreate);
    },
    onSuccess: async (result) => {
      const created = result.data;
      props.onSaved?.(created);
      const proxyRenameFailures: string[] = [];
      if (isEdit && renameCascade) {
        for (const item of renameCascade.targetRenames) {
          if (renameSkips[`target:${item.id}`]) {
            continue;
          }
          try {
            await updateApiProxyTarget(item.id, { name: item.to });
          } catch (error) {
            proxyRenameFailures.push(
              `target ${item.from}: ${(error as Error).message}`,
            );
          }
        }
        for (const item of renameCascade.modelRenames) {
          if (renameSkips[`model:${item.id}`]) {
            continue;
          }
          try {
            await updateApiProxyModel(item.id, { modelId: item.to });
          } catch (error) {
            proxyRenameFailures.push(
              `model ${item.from}: ${(error as Error).message}`,
            );
          }
        }
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

      await invalidateSavedInstance(created.name);
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
