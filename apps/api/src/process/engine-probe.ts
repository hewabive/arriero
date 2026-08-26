import {
  engineDescriptor,
  type EngineProbeId,
  type Instance,
  type InstanceKind,
  type InstanceProbe,
} from "@arriero/core";

import {
  offlineLlamaProbe,
  offlineRpcWorkerProbe,
  probeLlamaServer,
  probeRpcWorker,
} from "../llama/probe.js";
import { probeJson, requestJsonProbe } from "../instances/endpoint.js";
import { runtimeInstanceBaseUrl } from "./runtime-endpoint.js";

export type EngineProbeRunner = {
  probe: (instance: Instance) => Promise<InstanceProbe>;
  offline: (instance: Instance, error: string) => InstanceProbe;
};

function offlineOpenAiProbe(instance: Instance, error: string): InstanceProbe {
  const baseUrl = runtimeInstanceBaseUrl(instance);
  const failed = (path: string) => ({
    ok: false,
    url: baseUrl ? `${baseUrl}${path}` : "",
    status: null,
    latencyMs: 0,
    error,
  });
  return {
    baseUrl,
    health: failed("/health"),
    models: failed("/v1/models"),
    llama: null,
  };
}

async function probeOpenAiHttp(instance: Instance): Promise<InstanceProbe> {
  const baseUrl = runtimeInstanceBaseUrl(instance);
  if (!baseUrl) {
    return offlineOpenAiProbe(instance, "HTTP endpoint is not configured.");
  }
  const timeoutMs = engineDescriptor(instance.kind).probe.httpTimeoutMs;
  const probe =
    timeoutMs !== undefined
      ? (url: string) => requestJsonProbe(url, { timeoutMs })
      : probeJson;
  const [health, models] = await Promise.all([
    probe(`${baseUrl}/health`),
    probe(`${baseUrl}/v1/models`),
  ]);
  return {
    baseUrl,
    health,
    models,
    llama: null,
  };
}

const ENGINE_PROBES: Record<EngineProbeId, EngineProbeRunner> = {
  "llama-http": { probe: probeLlamaServer, offline: offlineLlamaProbe },
  "tcp-accept": { probe: probeRpcWorker, offline: offlineRpcWorkerProbe },
  "openai-http": { probe: probeOpenAiHttp, offline: offlineOpenAiProbe },
};

export function engineProbe(kind: InstanceKind): EngineProbeRunner {
  return ENGINE_PROBES[engineDescriptor(kind).probe.id];
}
