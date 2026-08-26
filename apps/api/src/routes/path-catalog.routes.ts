import {
  PathCatalogCreateSchema,
  PathCatalogKindSchema,
  PathCatalogUpdateSchema,
} from "@arriero/core";
import type { Hono } from "hono";

import { listInstances } from "../instances/repository.js";
import {
  createPathCatalogEntry,
  deletePathCatalogEntry,
  listPathCatalogEntries,
  updatePathCatalogEntry,
} from "../path-catalog/repository.js";
import { parseJsonBody } from "./validation.js";

export function registerPathCatalogRoutes(app: Hono) {
  app.get("/api/path-catalog", (c) => {
    const kindInput = c.req.query("kind");
    const kindResult = kindInput
      ? PathCatalogKindSchema.safeParse(kindInput)
      : null;
    if (kindResult && !kindResult.success) {
      return c.json({ error: kindResult.error.flatten() }, 400);
    }
    const kind = kindResult?.data;
    return c.json({ data: listPathCatalogEntries(kind) });
  });

  app.post("/api/path-catalog", async (c) => {
    const body = await parseJsonBody(c, PathCatalogCreateSchema);
    try {
      return c.json({ data: createPathCatalogEntry(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch("/api/path-catalog/:id", async (c) => {
    const body = await parseJsonBody(c, PathCatalogUpdateSchema);
    try {
      const entry = updatePathCatalogEntry(c.req.param("id"), body);
      if (!entry) {
        return c.json({ error: "path catalog entry not found" }, 404);
      }
      return c.json({ data: entry });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/path-catalog/:id", (c) => {
    const id = c.req.param("id");
    const usedBy = listInstances().filter(
      (instance) => instance.binaryPathRefId === id,
    );
    if (usedBy.length > 0) {
      return c.json(
        {
          error: `path catalog entry is used by ${usedBy.length} instance(s)`,
        },
        400,
      );
    }
    const deleted = deletePathCatalogEntry(id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });
}
