import {
  engineDescriptor,
  type EngineProxyCapabilities,
  type Instance,
} from "@arriero/core";

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

function evictionPolicy(instance: Instance) {
  return (
    instance.scheduling?.evictionPolicy ??
    engineDescriptor(instance.kind).defaultEvictionPolicy
  );
}

export function schedulerTargetPreemptible(
  instance: Instance | null,
  configuredPreemptible: boolean,
  activeRequests: number,
): boolean {
  if (!instance || !configuredPreemptible) return configuredPreemptible;
  const policy = evictionPolicy(instance);
  if (policy === "never") return false;
  if (policy === "idle-only") return activeRequests === 0;
  return true;
}

export function requestLeasePreemptible(
  instance: Instance | null,
  configuredPreemptible: boolean,
): boolean {
  if (!instance || !configuredPreemptible) return configuredPreemptible;
  return evictionPolicy(instance) === "preemptible";
}
