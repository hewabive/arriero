import { MemoryPoolUpdateSchema } from "@arriero/core";
import type { Hono } from "hono";

import { listInstances } from "../instances/repository.js";
import { currentResourceLedger } from "../resources/ledger.js";
import {
  deleteMemoryPool,
  getMemoryPool,
  isMemoryPoolOrphaned,
  listMemoryPoolsWithStatus,
  updateMemoryPool,
} from "../resources/repository.js";
import {
  getKnownGpuInventory,
  getSystemResources,
} from "../system/resources.js";

export function registerResourceRoutes(app: Hono) {
  app.get("/api/resources", (c) => {
    return c.json({
      data: {
        pools: listMemoryPoolsWithStatus(),
        ledger: currentResourceLedger(),
        detected: getSystemResources(),
      },
    });
  });

  app.put("/api/resources/pools/:id", async (c) => {
    const parsed = MemoryPoolUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const pool = updateMemoryPool(c.req.param("id"), parsed.data);
    if (!pool) {
      return c.json({ error: "memory pool not found" }, 404);
    }
    return c.json({ data: pool });
  });

  app.delete("/api/resources/pools/:id", (c) => {
    const id = c.req.param("id");
    const pool = getMemoryPool(id);
    if (!pool) {
      return c.json({ error: "memory pool not found" }, 404);
    }
    if (!isMemoryPoolOrphaned(pool, getKnownGpuInventory())) {
      return c.json(
        {
          error:
            "only orphaned pools can be deleted; pools for present hardware are re-created on startup",
        },
        400,
      );
    }
    const holders = listInstances()
      .filter((instance) => instance.memory.some((draw) => draw.poolId === id))
      .map((instance) => instance.name);
    if (holders.length > 0) {
      return c.json(
        {
          error: `memory pool is declared by instances: ${holders.join(", ")}`,
        },
        400,
      );
    }
    deleteMemoryPool(id);
    return c.json({ data: { deleted: id } });
  });
}
