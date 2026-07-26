import {
  engineDescriptor,
  type EngineProbeId,
  type EndpointProbe,
  type Instance,
  type InstanceKind,
  type LlamaProbe,
} from "@llama-manager/core";

import {
  offlineLlamaProbe,
  probeLlamaServer,
  probeRpcWorker,
} from "../llama/probe.js";
import { instanceBaseUrl, probeJson } from "../instances/endpoint.js";

export type EngineProbeRunner = {
  probe: (instance: Instance) => Promise<LlamaProbe>;
  offline: (instance: Instance, error: string) => LlamaProbe;
};

function notApplicable(error: string): EndpointProbe {
  return { ok: false, url: "", status: null, latencyMs: 0, error };
}

function offlineOpenAiProbe(instance: Instance, error: string): LlamaProbe {
  const baseUrl = instanceBaseUrl(instance);
  const failed = (path: string): EndpointProbe => ({
    ok: false,
    url: baseUrl ? `${baseUrl}${path}` : "",
    status: null,
    latencyMs: 0,
    error,
  });
  const unavailable = notApplicable(
    "not applicable for OpenAI-compatible engine",
  );
  return {
    baseUrl,
    health: failed("/health"),
    props: unavailable,
    slots: unavailable,
    models: failed("/v1/models"),
    modelDiagnostics: {},
  };
}

async function probeOpenAiHttp(instance: Instance): Promise<LlamaProbe> {
  const baseUrl = instanceBaseUrl(instance);
  if (!baseUrl) {
    return offlineOpenAiProbe(instance, "HTTP endpoint is not configured.");
  }
  const unavailable = notApplicable(
    "not applicable for OpenAI-compatible engine",
  );
  const [health, models] = await Promise.all([
    probeJson(`${baseUrl}/health`),
    probeJson(`${baseUrl}/v1/models`),
  ]);
  return {
    baseUrl,
    health,
    props: unavailable,
    slots: unavailable,
    models,
    modelDiagnostics: {},
  };
}

const ENGINE_PROBES: Record<EngineProbeId, EngineProbeRunner> = {
  "llama-http": { probe: probeLlamaServer, offline: offlineLlamaProbe },
  "tcp-accept": { probe: probeRpcWorker, offline: offlineLlamaProbe },
  "openai-http": { probe: probeOpenAiHttp, offline: offlineOpenAiProbe },
};

export function engineProbe(kind: InstanceKind): EngineProbeRunner {
  return ENGINE_PROBES[engineDescriptor(kind).probe.id];
}
