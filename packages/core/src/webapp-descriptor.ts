import {
  CHAT_UI_DEFAULT_VERSION,
  type EnvironmentCreateInput,
  type EnvironmentEngine,
} from "./environments.js";

export const WEBAPP_KINDS = ["open-webui", "chat-ui"] as const;

export type WebappKind = (typeof WEBAPP_KINDS)[number];

export type WebappConfigRenderId = "open-webui" | "chat-ui";

export type WebappLogGrammar = "uvicorn" | "pino";

export type WebappDescriptor = {
  id: WebappKind;
  displayName: string;
  environmentEngine: EnvironmentEngine;
  defaultInstallVersion: string;
  builtInSignIn: boolean;
  modelListRefresh: "live" | "startup";
  http: { defaultHost: string; defaultPort: number };
  launch: {
    argvPrefix: readonly string[];
    hostFlag: string;
    portFlag: string;
  };
  probe: { path: string };
  configRender: WebappConfigRenderId;
  logGrammar: WebappLogGrammar;
  sessionSecret: boolean;
  reservedEnvKeys: readonly string[];
  upgradeBackupFiles: readonly string[];
  installFootprintNote: string | null;
};

const WEBAPP_DESCRIPTORS: Record<WebappKind, WebappDescriptor> = {
  "open-webui": {
    id: "open-webui",
    displayName: "Open WebUI",
    environmentEngine: "open-webui",
    defaultInstallVersion: "",
    builtInSignIn: true,
    modelListRefresh: "live",
    http: { defaultHost: "127.0.0.1", defaultPort: 3000 },
    launch: {
      argvPrefix: ["serve"],
      hostFlag: "--host",
      portFlag: "--port",
    },
    probe: { path: "/health" },
    configRender: "open-webui",
    logGrammar: "uvicorn",
    sessionSecret: true,
    reservedEnvKeys: [
      "AUDIO_STT_ENGINE",
      "DATA_DIR",
      "DEFAULT_MODELS",
      "ENABLE_OLLAMA_API",
      "ENABLE_PERSISTENT_CONFIG",
      "HOST",
      "OPENAI_API_BASE_URL",
      "OPENAI_API_BASE_URLS",
      "OPENAI_API_KEY",
      "OPENAI_API_KEYS",
      "PORT",
      "RAG_EMBEDDING_ENGINE",
      "WEBUI_AUTH",
      "WEBUI_SECRET_KEY",
    ],
    upgradeBackupFiles: ["webui.db"],
    installFootprintNote:
      "the open-webui package installs a 5-7 GB virtual environment",
  },
  "chat-ui": {
    id: "chat-ui",
    displayName: "Chat UI",
    environmentEngine: "chat-ui",
    defaultInstallVersion: CHAT_UI_DEFAULT_VERSION,
    builtInSignIn: false,
    modelListRefresh: "startup",
    http: { defaultHost: "127.0.0.1", defaultPort: 3001 },
    launch: {
      argvPrefix: [],
      hostFlag: "--host",
      portFlag: "--port",
    },
    probe: { path: "/healthcheck" },
    configRender: "chat-ui",
    logGrammar: "pino",
    sessionSecret: false,
    reservedEnvKeys: [
      "ENABLE_CONFIG_MANAGER",
      "HOST",
      "MONGOMS_DOWNLOAD_DIR",
      "MONGO_STORAGE_PATH",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "PORT",
    ],
    upgradeBackupFiles: ["db"],
    installFootprintNote:
      "the source build takes ~600 MB on disk; the first start downloads an ~80 MB embedded MongoDB",
  },
};

export function webappDescriptor(kind: WebappKind): WebappDescriptor {
  return WEBAPP_DESCRIPTORS[kind];
}

const WEBAPP_ENVIRONMENT_CREATE_INPUTS: Record<
  WebappKind,
  (version: string) => EnvironmentCreateInput
> = {
  "open-webui": (version) => ({ engine: "open-webui", version }),
  "chat-ui": (version) => ({ engine: "chat-ui", version }),
};

export function webappEnvironmentCreateInput(
  kind: WebappKind,
  version: string,
): EnvironmentCreateInput {
  return WEBAPP_ENVIRONMENT_CREATE_INPUTS[kind](version);
}
