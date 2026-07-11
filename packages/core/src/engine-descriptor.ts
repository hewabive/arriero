export const INSTANCE_KINDS = ["llama-server", "rpc-worker", "vllm"] as const;

export type InstanceKind = (typeof INSTANCE_KINDS)[number];

export type EngineProbeId = "llama-http" | "tcp-accept" | "openai-http";
export type EngineNativeApiId = "llama" | "none";
export type EngineArgvBuilderId = "flag-map";
export type EngineLogParserId = "llama" | "vllm";
export type EngineArgumentCatalogParserId =
  | "llama-help"
  | "vllm-help"
  | "none";
export type EngineEstimatorId = "gguf" | "none";
export type EngineResourceProfileId =
  | "llama-args"
  | "rpc-device-args"
  | "vllm-args";
export type EnginePreflightId = "llama-server" | "none";

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
  };
  preflight: {
    engineChecks: EnginePreflightId;
    argumentCatalogParser: EngineArgumentCatalogParserId;
  };
  logs: { parser: EngineLogParserId };
  estimator: EngineEstimatorId;
  resourceProfile: EngineResourceProfileId;
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
    resourceProfile: "llama-args",
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
    resourceProfile: "rpc-device-args",
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
      engineChecks: "none",
      argumentCatalogParser: "vllm-help",
    },
    logs: { parser: "vllm" },
    estimator: "none",
    resourceProfile: "vllm-args",
    form: { creatable: false, modelSource: "free-text" },
  },
};

export function engineDescriptor(kind: InstanceKind): EngineDescriptor {
  return ENGINE_DESCRIPTORS[kind];
}
