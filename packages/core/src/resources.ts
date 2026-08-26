import { z } from "zod";

import {
  MemoryPoolIdSchema,
  type InstanceMemoryDraw,
} from "./memory-assessment.js";
import { updateSchemaFrom } from "./schema-update.js";

export const MemoryPoolKindSchema = z.enum(["gpu", "host"]);

export const MemoryPoolSchema = z.object({
  id: MemoryPoolIdSchema,
  name: z.string().min(1).max(120),
  kind: MemoryPoolKindSchema,
  capacityBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative().default(0),
  deviceRef: z.string().min(1).nullable().default(null),
  autoCapacity: z.boolean().default(true),
});

export const MemoryPoolDeclarationSchema = MemoryPoolSchema.extend({
  capacityBytes: z.number().int().nonnegative().nullable().default(null),
})
  .catchall(z.unknown())
  .superRefine((pool, ctx) => {
    if (!pool.autoCapacity && pool.capacityBytes === null) {
      ctx.addIssue({
        code: "custom",
        path: ["capacityBytes"],
        message: "manual pools must declare capacityBytes",
      });
    }
  });

export const MemoryPoolDeclareSchema = z.object({
  deviceRef: z.string().min(1),
});

export const MemoryPoolViewSchema = MemoryPoolSchema.extend({
  orphaned: z.boolean().default(false),
});

export const MemoryPoolUpdateSchema = updateSchemaFrom(
  MemoryPoolSchema.omit({ id: true, kind: true, deviceRef: true }),
);

export const ResourcePoolUsageSchema = z.object({
  poolId: MemoryPoolIdSchema,
  name: z.string(),
  kind: MemoryPoolKindSchema,
  capacityBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  budgetBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
});

export const ResourceLedgerSchema = z.object({
  pools: z.array(ResourcePoolUsageSchema),
});

export const ResourceAdmissionShortfallSchema = z.object({
  poolId: MemoryPoolIdSchema,
  requestedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  deficitBytes: z.number().int(),
  missing: z.boolean().default(false),
});

export const ResourceAdmissionSchema = z.object({
  ok: z.boolean(),
  shortfalls: z.array(ResourceAdmissionShortfallSchema),
});

export function buildResourceLedger(
  pools: MemoryPool[],
  residents: Array<{ instanceId: string; draws: InstanceMemoryDraw[] }>,
): ResourceLedger {
  const usedByPool = new Map<string, number>();
  for (const resident of residents) {
    for (const draw of resident.draws) {
      usedByPool.set(
        draw.poolId,
        (usedByPool.get(draw.poolId) ?? 0) + draw.bytes,
      );
    }
  }
  return {
    pools: pools.map((pool) => {
      const budgetBytes = Math.max(0, pool.capacityBytes - pool.reservedBytes);
      const usedBytes = usedByPool.get(pool.id) ?? 0;
      return {
        poolId: pool.id,
        name: pool.name,
        kind: pool.kind,
        capacityBytes: pool.capacityBytes,
        reservedBytes: pool.reservedBytes,
        budgetBytes,
        usedBytes,
        availableBytes: Math.max(0, budgetBytes - usedBytes),
      };
    }),
  };
}

export function checkDrawAdmission(
  ledger: ResourceLedger,
  draws: InstanceMemoryDraw[],
): ResourceAdmission {
  const byPool = new Map(ledger.pools.map((pool) => [pool.poolId, pool]));
  const requested = new Map<string, number>();
  for (const draw of draws) {
    requested.set(draw.poolId, (requested.get(draw.poolId) ?? 0) + draw.bytes);
  }
  const shortfalls: ResourceAdmissionShortfall[] = [];
  for (const [poolId, requestedBytes] of requested) {
    if (requestedBytes <= 0) {
      continue;
    }
    const pool = byPool.get(poolId);
    const availableBytes = pool?.availableBytes ?? 0;
    if (!pool || requestedBytes > availableBytes) {
      shortfalls.push({
        poolId,
        requestedBytes,
        availableBytes,
        deficitBytes: requestedBytes - availableBytes,
        missing: !pool,
      });
    }
  }
  return { ok: shortfalls.length === 0, shortfalls };
}

export type MemoryPoolKind = z.infer<typeof MemoryPoolKindSchema>;
export type MemoryPool = z.infer<typeof MemoryPoolSchema>;
export type MemoryPoolDeclaration = z.infer<typeof MemoryPoolDeclarationSchema>;
export type MemoryPoolDeclare = z.infer<typeof MemoryPoolDeclareSchema>;
export type MemoryPoolView = z.infer<typeof MemoryPoolViewSchema>;
export type MemoryPoolUpdate = z.infer<typeof MemoryPoolUpdateSchema>;
export type ResourcePoolUsage = z.infer<typeof ResourcePoolUsageSchema>;
export type ResourceLedger = z.infer<typeof ResourceLedgerSchema>;
export type ResourceAdmissionShortfall = z.infer<
  typeof ResourceAdmissionShortfallSchema
>;
export type ResourceAdmission = z.infer<typeof ResourceAdmissionSchema>;
