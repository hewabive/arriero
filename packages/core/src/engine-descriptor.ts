export const INSTANCE_KINDS = [
  "llama-server",
  "rpc-worker",
  "vllm",
  "ktransformers",
] as const;

export type InstanceKind = (typeof INSTANCE_KINDS)[number];

export type EngineProbeId = "llama-http" | "tcp-accept" | "openai-http";
export type EngineNativeApiId = "llama" | "none";
export type EngineArgvBuilderId = "flag-map" | "argparse-flags";
export type EngineLogParserId = "llama" | "vllm" | "sglang";
export type EngineArgumentCatalogParserId =
  | "llama-help"
  | "vllm-help"
  | "sglang-help"
  | "none";
export type EngineEstimatorId = "gguf" | "vllm-gpu-util" | "none";
export type EngineBenchmarkServerMetricsId = "vllm-prometheus" | "none";
export type EngineResourceProfileId =
  | "llama-args"
  | "rpc-device-args"
  | "vllm-args"
  | "ktransformers-hybrid";
export type EnginePreflightId =
  | "llama-server"
  | "vllm"
  | "ktransformers"
  | "none";
export type EngineAssessmentFingerprintId =
  | "llama-binary-gguf"
  | "python-env"
  | "none";
export type EngineProcessTreePolicy =
  | "root-only"
  | "named-descendants"
  | "all-descendants";
export type EngineConcurrencyId =
  | "none"
  | "llama-parallel"
  | "vllm-sequences"
  | "sglang-max-running-requests";
export type EngineEvictionPolicy = "never" | "idle-only" | "preemptible";

export type EngineHttpDescriptor = {
  defaultHost: string;
  defaultPort: number;
  hostArgKeys: readonly string[];
  portArgKeys: readonly string[];
  apiPrefixArgKeys: readonly string[];
};

export type EngineProxyCapabilities = {
  serveEndpoint: boolean;
  requestLease: boolean;
  modelLoadUnload: boolean;
  slotSave: boolean;
  streamResume: boolean;
  sseTimings: boolean;
};

export type EngineDescriptor = {
  id: InstanceKind;
  displayName: string;
  http: EngineHttpDescriptor;
  proxy: EngineProxyCapabilities;
  probe: { id: EngineProbeId; httpHealth: boolean };
  nativeApi: EngineNativeApiId;
  launch: {
    injectSlotSavePath: boolean;
    argv: EngineArgvBuilderId;
    argvPrefix: readonly string[];
    pythonModule?: string;
  };
  preflight: {
    engineChecks: EnginePreflightId;
    argumentCatalogParser: EngineArgumentCatalogParserId;
  };
  logs: { parser: EngineLogParserId };
  estimator: EngineEstimatorId;
  benchmarkServerMetrics: EngineBenchmarkServerMetricsId;
  assessment: {
    fingerprint: EngineAssessmentFingerprintId;
    measuredBaseline: boolean;
  };
  resourceProfile: EngineResourceProfileId;
  processTree: EngineProcessTreePolicy;
  concurrency: EngineConcurrencyId;
  defaultEvictionPolicy: EngineEvictionPolicy;
  form: {
    creatable: boolean;
    modelSource: "gguf" | "none" | "free-text";
  };
};

const ENGINE_DESCRIPTORS: Record<InstanceKind, EngineDescriptor> = {
  "llama-server": {
    id: "llama-server",
    displayName: "llama-server",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 8080,
      hostArgKeys: ["--host"],
      portArgKeys: ["--port"],
      apiPrefixArgKeys: ["--api-prefix"],
    },
    proxy: {
      serveEndpoint: true,
      requestLease: true,
      modelLoadUnload: true,
      slotSave: true,
      streamResume: true,
      sseTimings: true,
    },
    probe: { id: "llama-http", httpHealth: true },
    nativeApi: "llama",
    launch: { injectSlotSavePath: true, argv: "flag-map", argvPrefix: [] },
    preflight: {
      engineChecks: "llama-server",
      argumentCatalogParser: "llama-help",
    },
    logs: { parser: "llama" },
    estimator: "gguf",
    benchmarkServerMetrics: "none",
    assessment: { fingerprint: "llama-binary-gguf", measuredBaseline: true },
    resourceProfile: "llama-args",
    processTree: "named-descendants",
    concurrency: "llama-parallel",
    defaultEvictionPolicy: "preemptible",
    form: { creatable: true, modelSource: "gguf" },
  },
  "rpc-worker": {
    id: "rpc-worker",
    displayName: "rpc-server",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 50052,
      hostArgKeys: ["--host"],
      portArgKeys: ["--port", "-p"],
      apiPrefixArgKeys: [],
    },
    proxy: {
      serveEndpoint: false,
      requestLease: false,
      modelLoadUnload: false,
      slotSave: false,
      streamResume: false,
      sseTimings: false,
    },
    probe: { id: "tcp-accept", httpHealth: false },
    nativeApi: "none",
    launch: { injectSlotSavePath: false, argv: "flag-map", argvPrefix: [] },
    preflight: {
      engineChecks: "none",
      argumentCatalogParser: "none",
    },
    logs: { parser: "llama" },
    estimator: "none",
    benchmarkServerMetrics: "none",
    assessment: { fingerprint: "none", measuredBaseline: false },
    resourceProfile: "rpc-device-args",
    processTree: "root-only",
    concurrency: "none",
    defaultEvictionPolicy: "never",
    form: { creatable: true, modelSource: "none" },
  },
  vllm: {
    id: "vllm",
    displayName: "vLLM",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 8000,
      hostArgKeys: ["--host"],
      portArgKeys: ["--port"],
      apiPrefixArgKeys: [],
    },
    proxy: {
      serveEndpoint: true,
      requestLease: true,
      modelLoadUnload: false,
      slotSave: false,
      streamResume: false,
      sseTimings: false,
    },
    probe: { id: "openai-http", httpHealth: true },
    nativeApi: "none",
    launch: {
      injectSlotSavePath: false,
      argv: "flag-map",
      argvPrefix: ["serve"],
    },
    preflight: {
      engineChecks: "vllm",
      argumentCatalogParser: "vllm-help",
    },
    logs: { parser: "vllm" },
    estimator: "vllm-gpu-util",
    benchmarkServerMetrics: "vllm-prometheus",
    assessment: { fingerprint: "python-env", measuredBaseline: true },
    resourceProfile: "vllm-args",
    processTree: "all-descendants",
    concurrency: "vllm-sequences",
    defaultEvictionPolicy: "preemptible",
    form: { creatable: true, modelSource: "free-text" },
  },
  ktransformers: {
    id: "ktransformers",
    displayName: "KTransformers (SGLang-KT)",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 30000,
      hostArgKeys: ["--host"],
      portArgKeys: ["--port"],
      apiPrefixArgKeys: [],
    },
    proxy: {
      serveEndpoint: true,
      requestLease: true,
      modelLoadUnload: false,
      slotSave: false,
      streamResume: false,
      sseTimings: false,
    },
    probe: { id: "openai-http", httpHealth: true },
    nativeApi: "none",
    launch: {
      injectSlotSavePath: false,
      argv: "argparse-flags",
      argvPrefix: [],
      pythonModule: "sglang.launch_server",
    },
    preflight: {
      engineChecks: "ktransformers",
      argumentCatalogParser: "sglang-help",
    },
    logs: { parser: "sglang" },
    estimator: "none",
    benchmarkServerMetrics: "none",
    assessment: { fingerprint: "python-env", measuredBaseline: true },
    resourceProfile: "ktransformers-hybrid",
    processTree: "all-descendants",
    concurrency: "sglang-max-running-requests",
    defaultEvictionPolicy: "idle-only",
    form: { creatable: true, modelSource: "free-text" },
  },
};

export function engineDescriptor(kind: InstanceKind): EngineDescriptor {
  return ENGINE_DESCRIPTORS[kind];
}
