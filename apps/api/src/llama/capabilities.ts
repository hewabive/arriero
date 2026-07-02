import type {
  Instance,
  LlamaCapabilitiesResult,
  LlamaCapability,
  LlamaCapabilityCategory,
  LlamaCapabilityStatus,
  LlamaEndpointProbe,
} from "@llama-manager/core";

import { latestProcessRun } from "../process/runs-repository.js";
import {
  llamaBaseUrl,
  llamaEndpointErrorMessage,
  modelRecordsFromProbe,
  requestLlamaJson,
} from "./endpoint-client.js";

const CAPABILITY_PROBE_TIMEOUT_MS = 4_000;

type CapabilityDefinition = {
  id: string;
  label: string;
  category: LlamaCapabilityCategory;
  method: "GET" | "POST";
  endpoint: string;
  modelScoped?: boolean;
  body?: (model: string | null) => Record<string, unknown>;
};

export const capabilityDefinitions: CapabilityDefinition[] = [
  {
    id: "health",
    label: "Health",
    category: "runtime",
    method: "GET",
    endpoint: "/health",
  },
  {
    id: "props",
    label: "Properties",
    category: "runtime",
    method: "GET",
    endpoint: "/props",
  },
  {
    id: "metrics",
    label: "Metrics",
    category: "runtime",
    method: "GET",
    endpoint: "/metrics",
    modelScoped: true,
  },
  {
    id: "slots",
    label: "Slots",
    category: "runtime",
    method: "GET",
    endpoint: "/slots",
    modelScoped: true,
  },
  {
    id: "lora-adapters",
    label: "LoRA adapters",
    category: "runtime",
    method: "GET",
    endpoint: "/lora-adapters",
    modelScoped: true,
  },
  {
    id: "stream-resume",
    label: "Stream resume",
    category: "runtime",
    method: "POST",
    endpoint: "/v1/streams/lookup",
    body: () => ({ conversation_ids: [] }),
  },
  {
    id: "models",
    label: "Models",
    category: "models",
    method: "GET",
    endpoint: "/v1/models",
  },
  {
    id: "chat",
    label: "Chat completions",
    category: "generation",
    method: "POST",
    endpoint: "/v1/chat/completions",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "completions",
    label: "Completions",
    category: "generation",
    method: "POST",
    endpoint: "/v1/completions",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "responses",
    label: "Responses",
    category: "generation",
    method: "POST",
    endpoint: "/v1/responses",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "infill",
    label: "Infill",
    category: "generation",
    method: "POST",
    endpoint: "/infill",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "anthropic-messages",
    label: "Anthropic messages",
    category: "generation",
    method: "POST",
    endpoint: "/v1/messages",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "audio-transcriptions",
    label: "Audio transcription",
    category: "generation",
    method: "POST",
    endpoint: "/v1/audio/transcriptions",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "tokenize",
    label: "Tokenize",
    category: "tokens",
    method: "POST",
    endpoint: "/tokenize",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "detokenize",
    label: "Detokenize",
    category: "tokens",
    method: "POST",
    endpoint: "/detokenize",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "count-tokens",
    label: "Count tokens",
    category: "tokens",
    method: "POST",
    endpoint: "/v1/messages/count_tokens",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "chat-input-tokens",
    label: "Chat input tokens",
    category: "tokens",
    method: "POST",
    endpoint: "/v1/chat/completions/input_tokens",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "responses-input-tokens",
    label: "Responses input tokens",
    category: "tokens",
    method: "POST",
    endpoint: "/v1/responses/input_tokens",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "apply-template",
    label: "Apply template",
    category: "tokens",
    method: "POST",
    endpoint: "/apply-template",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "embeddings",
    label: "Embeddings",
    category: "embeddings",
    method: "POST",
    endpoint: "/v1/embeddings",
    body: (model) => (model ? { model } : {}),
  },
  {
    id: "rerank",
    label: "Rerank",
    category: "embeddings",
    method: "POST",
    endpoint: "/v1/rerank",
    body: (model) => (model ? { model } : {}),
  },
];

function shouldUseModelForCapabilityProbe(status: string | null) {
  if (!status) {
    return true;
  }
  return ["loaded", "ready", "running", "sleeping"].includes(
    status.toLowerCase(),
  );
}

function selectedCapabilityModel(models: LlamaEndpointProbe) {
  const records = modelRecordsFromProbe(models);
  return (
    records.find((model) => shouldUseModelForCapabilityProbe(model.status))
      ?.id ?? null
  );
}

function capabilityStatus(probe: LlamaEndpointProbe): LlamaCapabilityStatus {
  if (probe.ok) return "available";
  if (probe.status === null) return "error";
  const message = llamaEndpointErrorMessage(probe).toLowerCase();
  if (
    probe.status === 404 ||
    message.includes("file not found") ||
    message.includes("does not support") ||
    message.includes("not supported") ||
    message.includes("start it with")
  ) {
    return "unsupported";
  }
  if (probe.status >= 400 && probe.status < 500) {
    return "available";
  }
  if (
    probe.status === 500 &&
    (message.includes(" is required") ||
      message.includes("key '") ||
      message.includes("json.exception.out_of_range"))
  ) {
    return "available";
  }
  return "error";
}

function capabilityUrl(
  baseUrl: string,
  definition: CapabilityDefinition,
  model: string | null,
) {
  const query =
    definition.modelScoped && model
      ? `?${new URLSearchParams({ model, autoload: "false" }).toString()}`
      : "";
  return `${baseUrl}${definition.endpoint}${query}`;
}

async function requestCapability(
  baseUrl: string,
  definition: CapabilityDefinition,
  model: string | null,
): Promise<LlamaCapability> {
  const probe = await requestLlamaJson(
    capabilityUrl(baseUrl, definition, model),
    {
      method: definition.method,
      ...(definition.method === "POST"
        ? {
            body: JSON.stringify(definition.body?.(model) ?? {}),
            headers: { "content-type": "application/json" },
          }
        : {}),
      timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    },
  );
  const status = capabilityStatus(probe);
  return {
    id: definition.id,
    label: definition.label,
    category: definition.category,
    method: definition.method,
    endpoint: definition.endpoint,
    status,
    httpStatus: probe.status,
    latencyMs: probe.latencyMs,
    reason: probe.ok ? null : llamaEndpointErrorMessage(probe),
    model: definition.modelScoped ? model : null,
  };
}

const capabilitiesCache = new Map<
  string,
  { runKey: string; result: LlamaCapabilitiesResult }
>();

export async function probeLlamaCapabilities(
  instance: Instance,
  options: { force?: boolean } = {},
): Promise<LlamaCapabilitiesResult> {
  const runKey = latestProcessRun(instance.name)?.id ?? null;
  if (!options.force && runKey) {
    const cached = capabilitiesCache.get(instance.name);
    if (cached && cached.runKey === runKey) {
      return cached.result;
    }
  }
  const result = await runCapabilityProbe(instance);
  if (runKey) {
    capabilitiesCache.set(instance.name, { runKey, result });
  } else {
    capabilitiesCache.delete(instance.name);
  }
  return result;
}

async function runCapabilityProbe(
  instance: Instance,
): Promise<LlamaCapabilitiesResult> {
  const baseUrl = llamaBaseUrl(instance);
  if (!baseUrl) {
    throw new Error("UNIX socket capability probes are not implemented yet");
  }

  const modelsDefinition = capabilityDefinitions.find(
    (definition) => definition.id === "models",
  )!;
  const modelsProbe = await requestLlamaJson(`${baseUrl}/v1/models`, {
    timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
  });
  const model = selectedCapabilityModel(modelsProbe);
  const modelsCapability: LlamaCapability = {
    id: modelsDefinition.id,
    label: modelsDefinition.label,
    category: modelsDefinition.category,
    method: modelsDefinition.method,
    endpoint: modelsDefinition.endpoint,
    status: capabilityStatus(modelsProbe),
    httpStatus: modelsProbe.status,
    latencyMs: modelsProbe.latencyMs,
    reason: modelsProbe.ok ? null : llamaEndpointErrorMessage(modelsProbe),
    model: null,
  };

  const capabilities = await Promise.all(
    capabilityDefinitions
      .filter((definition) => definition.id !== "models")
      .map((definition) => requestCapability(baseUrl, definition, model)),
  );

  return {
    baseUrl,
    checkedAt: new Date().toISOString(),
    model,
    capabilities: [modelsCapability, ...capabilities],
  };
}
