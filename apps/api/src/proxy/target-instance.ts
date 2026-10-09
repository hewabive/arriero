import {
  instanceIdFromEndpointId,
  type ApiProxyTargetRecord,
} from "@arriero/core";

import { externalTargetEndpointId } from "./external-target.js";
import { serveTargetInstanceId } from "./serve-target-id.js";

export function apiProxyTargetInstanceName(
  targetId: string,
  target: Pick<ApiProxyTargetRecord, "endpointId"> | null,
): string | null {
  if (target) {
    return instanceIdFromEndpointId(target.endpointId);
  }
  const servedInstanceId = serveTargetInstanceId(targetId);
  if (servedInstanceId !== null) {
    return servedInstanceId;
  }
  const endpointId = externalTargetEndpointId(targetId);
  return endpointId ? instanceIdFromEndpointId(endpointId) : null;
}
