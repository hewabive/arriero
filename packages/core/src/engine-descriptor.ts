export const INSTANCE_KINDS = [
  "llama-server",
  "rpc-worker",
  "vllm",
  "sglang",
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
  | "sglang-args"
  | "ktransformers-hybrid";
export type EnginePreflightId =
  | "llama-server"
  | "vllm"
  | "sglang"
  | "ktransformers"
  | "none";
export type EngineAssessmentFingerprintId =
  | "llama-binary-gguf"
  | "python-env"
  | "none";
export type EngineProcessTree =
  | { policy: "root-only" }
  | { policy: "all-descendants" }
  | {
      policy: "named-descendants";
      descendantNames: readonly string[];
      routerChildPortsFromLogs: boolean;
    };
export type EngineConcurrencyId =
  | "none"
  | "llama-parallel"
  | "vllm-sequences"
  | "sglang-max-running-requests";
export type EngineEvictionPolicy = "never" | "idle-only" | "preemptible";
export type EngineAdmissionPolicy = "confirmable" | "strict";

export type EngineHttpDescriptor = {
  defaultHost: string;
  defaultPort: number;
  loopbackOnly: boolean;
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
  probe: { id: EngineProbeId; httpHealth: boolean; httpTimeoutMs?: number };
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
  processTree: EngineProcessTree;
  concurrency: EngineConcurrencyId;
  admission: EngineAdmissionPolicy;
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
      loopbackOnly: false,
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
    processTree: {
      policy: "named-descendants",
      descendantNames: ["llama-server"],
      routerChildPortsFromLogs: true,
    },
    concurrency: "llama-parallel",
    admission: "confirmable",
    defaultEvictionPolicy: "preemptible",
    form: { creatable: true, modelSource: "gguf" },
  },
  "rpc-worker": {
    id: "rpc-worker",
    displayName: "rpc-server",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 50052,
      loopbackOnly: false,
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
    processTree: { policy: "root-only" },
    concurrency: "none",
    admission: "confirmable",
    defaultEvictionPolicy: "never",
    form: { creatable: true, modelSource: "none" },
  },
  vllm: {
    id: "vllm",
    displayName: "vLLM",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 8000,
      loopbackOnly: false,
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
    processTree: { policy: "all-descendants" },
    concurrency: "vllm-sequences",
    admission: "confirmable",
    defaultEvictionPolicy: "preemptible",
    form: { creatable: true, modelSource: "free-text" },
  },
  sglang: {
    id: "sglang",
    displayName: "SGLang",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 30000,
      loopbackOnly: true,
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
    probe: { id: "openai-http", httpHealth: true, httpTimeoutMs: 15_000 },
    nativeApi: "none",
    launch: {
      injectSlotSavePath: false,
      argv: "argparse-flags",
      argvPrefix: [],
      pythonModule: "sglang.launch_server",
    },
    preflight: {
      engineChecks: "sglang",
      argumentCatalogParser: "sglang-help",
    },
    logs: { parser: "sglang" },
    estimator: "none",
    benchmarkServerMetrics: "none",
    assessment: { fingerprint: "python-env", measuredBaseline: true },
    resourceProfile: "sglang-args",
    processTree: { policy: "all-descendants" },
    concurrency: "sglang-max-running-requests",
    admission: "confirmable",
    defaultEvictionPolicy: "preemptible",
    form: { creatable: true, modelSource: "free-text" },
  },
  ktransformers: {
    id: "ktransformers",
    displayName: "KTransformers (SGLang-KT)",
    http: {
      defaultHost: "127.0.0.1",
      defaultPort: 30000,
      loopbackOnly: true,
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
    probe: { id: "openai-http", httpHealth: true, httpTimeoutMs: 15_000 },
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
    processTree: { policy: "all-descendants" },
    concurrency: "sglang-max-running-requests",
    admission: "strict",
    defaultEvictionPolicy: "idle-only",
    form: { creatable: true, modelSource: "free-text" },
  },
};

export function engineDescriptor(kind: InstanceKind): EngineDescriptor {
  return ENGINE_DESCRIPTORS[kind];
}
