import {
  InstanceArgsSchema,
  KTRANSFORMERS_RESERVED_ARG_KEYS,
  RPC_SERVER_SUPPORTED_FLAGS,
  engineDescriptor,
  ggufModelRole,
  ggufPoolingTypeLabel,
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
  createInstance,
  estimateInstanceMemory,
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
  updateInstance,
} from "../../api/client";
import { useScannedModels } from "../hooks/use-scanned-models";
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

  useEffect(() => {
    if (!props.opened) {
      initializedFormKeyRef.current = null;
      catalogNormalizedFormKeyRef.current = null;
      setInitializedFormKey(null);
      return;
    }

    const formKey = `${props.instance?.name ?? "new"}:${props.initialModelPath ?? ""}`;
    if (initializedFormKeyRef.current === formKey) {
      return;
    }
    if (!props.instance && argumentDefaultsQuery.isLoading) {
      return;
    }
    initializedFormKeyRef.current = formKey;
    setInitializedFormKey(formKey);

    if (props.instance) {
      const modelPath = argString(props.instance.args, "--model") || null;
      const presetPathValue =
        argString(props.instance.args, "--models-preset") || null;
      const presetName = presetPathValue
        ? presetNameFromPath(presetPathValue)
        : null;
      form.setValues({
        name: props.instance.name,
        envJson: JSON.stringify(props.instance.env, null, 2),
      });
      setCustomEnvRows(buildEnvRows(props.instance.env));
      setShowEnvRawJson(false);
      setKind(props.instance.kind);
      setModelReference(
        props.instance.engineConfig?.type === "ktransformers"
          ? props.instance.engineConfig.model
          : (props.instance.positionalArgs?.[0] ?? ""),
      );
      setKTransformersCpuWeights(
        props.instance.engineConfig?.type === "ktransformers"
          ? props.instance.engineConfig.cpuWeights
          : "",
      );
      setKTransformersMethod(
        props.instance.engineConfig?.type === "ktransformers"
          ? props.instance.engineConfig.method
          : "FP8",
      );
      setKTransformersServedModelName(
        props.instance.engineConfig?.type === "ktransformers"
          ? (props.instance.engineConfig.servedModelName ?? "")
          : "",
      );
      setEvictionPolicy(
        props.instance.scheduling?.evictionPolicy ??
          engineDescriptor(props.instance.kind).defaultEvictionPolicy,
      );
      setRpcWorkers(props.instance.rpcWorkers);
      setSelectedBinaryPathRefId(props.instance.binaryPathRefId);
      setSelectedModelPath(modelPath);
      setSelectedPresetName(presetName);
      const mode = launchModeFromArgs(props.instance.args);
      setLaunchMode(mode);
      if (mode === "remote") {
        setRemoteSource(
          hasConfiguredArg(props.instance.args, "--model-url") ? "url" : "hf",
        );
      }
      setSpecEnabled(hasSpecConfig(props.instance.args));
      setSpecSource(
        hasConfiguredArg(props.instance.args, SPEC_DRAFT_HF_KEY)
          ? "hf"
          : "local",
      );
      setSpecAdvancedOpen(
        SPEC_ADVANCED_KEYS.some((key) =>
          hasConfiguredArg(props.instance!.args, key),
        ),
      );
      setStartAfterCreate(false);
      setArgRows(argsToRows(props.instance.args, knownArgByName));
      setMemoryRows(memoryRowsFromDraws(props.instance.memory));
      const numa = props.instance.numa;
      setNumaMode(numa?.mode ?? "none");
      setNumaBindNode(numa?.mode === "bind" ? numa.node : null);
      setNumaInterleaveNodes(numa?.mode === "interleave" ? numa.nodes : []);
    } else {
      const modelPath = props.initialModelPath ?? null;
      const port = nextAvailablePort(props.instances);
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
  }, [
    argumentDefaultsQuery.isLoading,
    props.opened,
    props.instance?.name,
    props.initialModelPath,
  ]);

  useEffect(() => {
    if (!props.opened || !props.instance || knownArgByName.size === 0) {
      return;
    }
    const formKey = `${props.instance.name}:${props.initialModelPath ?? ""}`;
    if (
      initializedFormKeyRef.current !== formKey ||
      catalogNormalizedFormKeyRef.current === formKey
    ) {
      return;
    }
    catalogNormalizedFormKeyRef.current = formKey;
    setArgRows(argsToRows(props.instance.args, knownArgByName));
  }, [props.opened, props.instance, props.initialModelPath, knownArgByName]);

  useEffect(() => {
    if (
      !props.opened ||
      props.instance ||
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
    props.instance,
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

  const estimateArgs = draftPreview.input?.args ?? null;
  const estimateArgsKey = draftPreview.input
    ? JSON.stringify({
        kind: draftPreview.input.kind,
        args: draftPreview.input.args,
        positionalArgs: draftPreview.input.positionalArgs,
        env: draftPreview.input.env,
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
        args: estimateArgs,
        positionalArgs: draftPreview.input?.positionalArgs,
        env: draftPreview.input?.env,
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
    if (
      !isEdit &&
      modelPath &&
      (!form.values.name ||
        form.values.name === "local-server" ||
        form.values.name === "local-router")
    ) {
      form.setFieldValue("name", instanceNameFromModelPath(modelPath));
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
    const base = trimmed.split(":")[0] ?? trimmed;
    const name = (base.split("/").filter(Boolean).pop() ?? "").replace(
      /\.gguf$/i,
      "",
    );
    if (
      !isEdit &&
      name &&
      (!form.values.name ||
        form.values.name === "local-server" ||
        form.values.name === "local-router")
    ) {
      form.setFieldValue("name", name);
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
    !props.instance &&
    initializedFormKey === null &&
    argumentDefaultsQuery.isLoading;
  const modalTitle = `${isEdit ? "Edit" : "New"} ${kind} instance`;

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
    submit,
  };
}

export type InstanceFormController = ReturnType<typeof useInstanceForm>;
