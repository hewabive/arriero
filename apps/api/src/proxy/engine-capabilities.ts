import { engineDescriptor, type Instance } from "@llama-manager/core";

export type ProxyEngineGates = {
  modelLoadUnload: boolean;
  slotSave: boolean;
  streamResume: boolean;
  sseTimings: boolean;
};

const NO_ENGINE_GATES: ProxyEngineGates = {
  modelLoadUnload: false,
  slotSave: false,
  streamResume: false,
  sseTimings: false,
};

export function proxyEngineGates(instance: Instance | null): ProxyEngineGates {
  if (!instance) {
    return NO_ENGINE_GATES;
  }
  const proxy = engineDescriptor(instance.kind).proxy;
  return {
    modelLoadUnload: proxy.modelLoadUnload,
    slotSave: proxy.slotSave,
    streamResume: proxy.streamResume,
    sseTimings: proxy.sseTimings,
  };
}
