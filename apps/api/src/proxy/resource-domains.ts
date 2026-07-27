import type {
  ApiProxySchedulerPoolInput,
  InstanceMemoryDraw,
  MemoryPool,
} from "@arriero/core";

function drawnDomains(
  draws: InstanceMemoryDraw[],
  poolIds: Set<string>,
): string[] {
  const domains = new Set<string>();
  for (const draw of draws) {
    if (poolIds.has(draw.poolId)) {
      domains.add(draw.poolId);
    }
  }
  return [...domains].sort();
}

export function computeDomains(
  draws: InstanceMemoryDraw[],
  pools: Pick<MemoryPool, "id">[],
): string[] {
  return drawnDomains(draws, new Set(pools.map((pool) => pool.id)));
}

export function requestComputeDomains(
  draws: InstanceMemoryDraw[],
  pools: Pick<ApiProxySchedulerPoolInput, "poolId">[],
): string[] {
  return drawnDomains(draws, new Set(pools.map((pool) => pool.poolId)));
}
