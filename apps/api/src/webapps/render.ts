import {
  webappDescriptor,
  type WebappConfigRecord,
  type WebappConfigRenderId,
} from "@arriero/core";

import { config } from "../config.js";
import { getApiProxySourceKey } from "../proxy/sources.js";
import { webappDataDir } from "./paths.js";
import { webappSecretKey } from "./secrets.js";

const FALLBACK_PROXY_API_KEY = "arriero-webapp";

type WebappEnvironmentRenderer = (
  record: WebappConfigRecord,
) => Record<string, string>;

function proxyBaseUrl(): string {
  return `http://127.0.0.1:${config.port}/v1`;
}

function proxyApiKey(record: WebappConfigRecord): string {
  if (!record.proxySourceId) {
    return FALLBACK_PROXY_API_KEY;
  }
  return getApiProxySourceKey(record.proxySourceId) ?? FALLBACK_PROXY_API_KEY;
}

function renderOpenWebui(record: WebappConfigRecord): Record<string, string> {
  const settings = record.settings;
  return {
    DATA_DIR: webappDataDir(record.name),
    ENABLE_PERSISTENT_CONFIG: "False",
    ENABLE_OLLAMA_API: "False",
    OPENAI_API_BASE_URL: proxyBaseUrl(),
    OPENAI_API_KEY: proxyApiKey(record),
    WEBUI_AUTH: settings.auth ? "True" : "False",
    WEBUI_SECRET_KEY: webappSecretKey(record.name) ?? "",
    ...(settings.defaultModels.length
      ? { DEFAULT_MODELS: settings.defaultModels.join(",") }
      : {}),
    ...(settings.slim
      ? { RAG_EMBEDDING_ENGINE: "openai", AUDIO_STT_ENGINE: "openai" }
      : {}),
    ...settings.extraEnv,
  };
}

const WEBAPP_ENVIRONMENT_RENDERERS: Record<
  WebappConfigRenderId,
  WebappEnvironmentRenderer
> = {
  "open-webui": renderOpenWebui,
};

export function renderWebappEnvironment(
  record: WebappConfigRecord,
): Record<string, string> {
  const renderer =
    WEBAPP_ENVIRONMENT_RENDERERS[webappDescriptor(record.kind).configRender];
  return renderer(record);
}
