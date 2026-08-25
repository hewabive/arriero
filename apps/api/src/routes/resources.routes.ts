import { MemoryPoolDeclareSchema, MemoryPoolUpdateSchema } from "@arriero/core";
import type { Hono } from "hono";

import { listInstances } from "../instances/repository.js";
import { currentResourceLedger } from "../resources/ledger.js";
import {
  declareGpuPool,
  deleteMemoryPool,
  getMemoryPool,
  isMemoryPoolOrphaned,
  listMemoryPoolsWithStatus,
  listUndeclaredAccelerators,
  updateMemoryPool,
} from "../resources/repository.js";
import {
  getKnownGpuInventory,
  getSystemResources,
} from "../system/resources.js";

export function registerResourceRoutes(app: Hono) {
  app.get("/api/resources", (c) => {
    const detected = getSystemResources();
    return c.json({
      data: {
        pools: listMemoryPoolsWithStatus(getKnownGpuInventory(), detected),
        ledger: currentResourceLedger(),
        detected,
        undeclared: listUndeclaredAccelerators(detected),
      },
    });
  });

  app.post("/api/resources/pools", async (c) => {
    const parsed = MemoryPoolDeclareSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const declared = declareGpuPool(parsed.data.deviceRef);
    if (!declared) {
      return c.json({ error: "no detected gpu with that device ref" }, 404);
    }
    return c.json({ data: declared }, 201);
  });

  app.put("/api/resources/pools/:id", async (c) => {
    const parsed = MemoryPoolUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const id = c.req.param("id");
    const current = getMemoryPool(id);
    if (!current) {
      return c.json({ error: "memory pool not found" }, 404);
    }
    const nextAuto = parsed.data.autoCapacity ?? current.autoCapacity;
    if (nextAuto && parsed.data.capacityBytes !== undefined) {
      return c.json(
        { error: "capacity is derived from hardware for auto pools" },
        400,
      );
    }
    if (
      !nextAuto &&
      (parsed.data.capacityBytes ?? current.capacityBytes) === null
    ) {
      return c.json({ error: "manual pools must declare capacityBytes" }, 400);
    }
    const pool = updateMemoryPool(id, parsed.data);
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
