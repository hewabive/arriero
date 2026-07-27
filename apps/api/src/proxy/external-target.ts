import type { ApiProxyTargetRecord } from "@arriero/core";

export function externalEndpointTarget(input: {
  endpointId: string;
  upstreamModel: string | null;
  name: string;
  now: string;
}): ApiProxyTargetRecord {
  const modelSuffix = input.upstreamModel ?? input.name;
  return {
    id: `endpoint:${input.endpointId}#${modelSuffix}`,
    name: input.name,
    endpointId: input.endpointId,
    model: input.upstreamModel,
    role: "interactive",
    priority: 100,
    preemptible: false,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
