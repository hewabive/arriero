import {
  engineDescriptor,
  type EngineProbeId,
  type Instance,
  type InstanceKind,
  type LlamaProbe,
} from "@llama-manager/core";

import {
  offlineLlamaProbe,
  probeLlamaServer,
  probeRpcWorker,
} from "../llama/probe.js";

export type EngineProbeRunner = {
  probe: (instance: Instance) => Promise<LlamaProbe>;
  offline: (instance: Instance, error: string) => LlamaProbe;
};

const ENGINE_PROBES: Record<EngineProbeId, EngineProbeRunner> = {
  "llama-http": { probe: probeLlamaServer, offline: offlineLlamaProbe },
  "tcp-accept": { probe: probeRpcWorker, offline: offlineLlamaProbe },
};

export function engineProbe(kind: InstanceKind): EngineProbeRunner {
  return ENGINE_PROBES[engineDescriptor(kind).probe.id];
}
