import {
  engineDescriptor,
  type EngineProxyCapabilities,
  type Instance,
} from "@llama-manager/core";

export type ProxyEngineGates = Pick<
  EngineProxyCapabilities,
  | "requestLease"
  | "modelLoadUnload"
  | "slotSave"
  | "streamResume"
  | "sseTimings"
>;

const NO_ENGINE_GATES: ProxyEngineGates = {
  requestLease: false,
  modelLoadUnload: false,
  slotSave: false,
  streamResume: false,
  sseTimings: false,
};

export function proxyEngineGates(instance: Instance | null): ProxyEngineGates {
  if (!instance) return NO_ENGINE_GATES;
  const proxy = engineDescriptor(instance.kind).proxy;
  return {
    requestLease: proxy.requestLease,
    modelLoadUnload: proxy.modelLoadUnload,
    slotSave: proxy.slotSave,
    streamResume: proxy.streamResume,
    sseTimings: proxy.sseTimings,
  };
}
