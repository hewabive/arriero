import type { ApiProxyTargetRecord } from "@arriero/core";

const EXTERNAL_TARGET_ID_PREFIX = "endpoint:";

export function externalTargetEndpointId(targetId: string): string | null {
  if (!targetId.startsWith(EXTERNAL_TARGET_ID_PREFIX)) {
    return null;
  }
  return targetId.slice(EXTERNAL_TARGET_ID_PREFIX.length).split("#")[0] || null;
}

export function externalEndpointTarget(input: {
  endpointId: string;
  upstreamModel: string | null;
  name: string;
}): ApiProxyTargetRecord {
  const modelSuffix = input.upstreamModel ?? input.name;
  return {
    id: `${EXTERNAL_TARGET_ID_PREFIX}${input.endpointId}#${modelSuffix}`,
    name: input.name,
    endpointId: input.endpointId,
    model: input.upstreamModel,
    role: "interactive",
    priority: 100,
    preemptible: false,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  };
}
