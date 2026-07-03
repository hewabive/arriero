import {
  engineDescriptor,
  type EngineProxyCapabilities,
  type Instance,
} from "@llama-manager/core";

export type ProxyEngineGates = Pick<
  EngineProxyCapabilities,
  "modelLoadUnload" | "slotSave" | "streamResume" | "sseTimings"
>;

const NO_ENGINE_GATES: ProxyEngineGates = {
  modelLoadUnload: false,
  slotSave: false,
  streamResume: false,
  sseTimings: false,
};

export function proxyEngineGates(instance: Instance | null): ProxyEngineGates {
  return instance ? engineDescriptor(instance.kind).proxy : NO_ENGINE_GATES;
}
