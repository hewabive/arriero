import {
  buildResourceLedger,
  checkDrawAdmission,
  type ApiProxySchedulerPoolInput,
  type InstanceMemoryDraw,
  type MemoryPool,
  type ResourceAdmission,
  type ResourceLedger,
} from "@arriero/core";

import { listInstances } from "../instances/repository.js";
import { listMemoryPools } from "./repository.js";

const RESIDENT_STATUSES = new Set<string>(["starting", "running"]);

type ResidentDraw = { instanceId: string; draws: InstanceMemoryDraw[] };

export function currentResidentDraws(
  options: { excludeInstanceId?: string } = {},
): ResidentDraw[] {
  return listInstances()
    .filter((instance) => RESIDENT_STATUSES.has(instance.status))
    .filter((instance) => instance.name !== options.excludeInstanceId)
    .map((instance) => ({ instanceId: instance.name, draws: instance.memory }));
}

export function currentResourceLedger(
  options: { excludeInstanceId?: string } = {},
): ResourceLedger {
  return buildResourceLedger(listMemoryPools(), currentResidentDraws(options));
}

export function admitInstanceDraw(
  draws: InstanceMemoryDraw[],
  options: { excludeInstanceId?: string } = {},
): ResourceAdmission {
  return checkDrawAdmission(currentResourceLedger(options), draws);
}

export function computeSchedulerPoolInputs(
  pools: MemoryPool[],
  residents: ResidentDraw[],
  targetInstanceIds: Set<string>,
): ApiProxySchedulerPoolInput[] {
  return pools.map((pool) => {
    const usedByOthersBytes = residents
      .filter((resident) => !targetInstanceIds.has(resident.instanceId))
      .reduce(
        (sum, resident) =>
          sum +
          resident.draws
            .filter((draw) => draw.poolId === pool.id)
            .reduce((acc, draw) => acc + draw.bytes, 0),
        0,
      );
    return {
      poolId: pool.id,
      kind: pool.kind,
      budgetBytes: Math.max(0, pool.capacityBytes - pool.reservedBytes),
      usedByOthersBytes,
    };
  });
}

export function schedulerPoolInputs(
  targetInstanceIds: Set<string>,
): ApiProxySchedulerPoolInput[] {
  return computeSchedulerPoolInputs(
    listMemoryPools(),
    currentResidentDraws(),
    targetInstanceIds,
  );
}
