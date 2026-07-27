import { MemoryPoolUpdateSchema } from "@arriero/core";
import type { Hono } from "hono";

import { currentResourceLedger } from "../resources/ledger.js";
import { listMemoryPools, updateMemoryPool } from "../resources/repository.js";
import { getSystemResources } from "../system/resources.js";

export function registerResourceRoutes(app: Hono) {
  app.get("/api/resources", (c) => {
    return c.json({
      data: {
        pools: listMemoryPools(),
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
}
