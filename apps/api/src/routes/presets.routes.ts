import { ModelPresetCreateSchema, ModelPresetWriteSchema } from "@arriero/core";
import type { Hono } from "hono";

import {
  createPreset,
  deletePreset,
  listPresets,
  readPreset,
  writePreset,
} from "../presets/repository.js";
import { parseJsonBody } from "./validation.js";

export function registerPresetRoutes(app: Hono) {
  app.get("/api/presets", (c) => {
    return c.json({ data: listPresets() });
  });

  app.post("/api/presets", async (c) => {
    const body = await parseJsonBody(c, ModelPresetCreateSchema);
    const result = createPreset(body);
    if (result.kind === "exists") {
      return c.json({ error: "preset already exists" }, 409);
    }
    return c.json({ data: result.document }, 201);
  });

  app.get("/api/presets/:name", (c) => {
    const document = readPreset(c.req.param("name"));
    if (!document) {
      return c.json({ error: "preset not found" }, 404);
    }
    return c.json({ data: document });
  });

  app.put("/api/presets/:name", async (c) => {
    const body = await parseJsonBody(c, ModelPresetWriteSchema);
    const result = writePreset(c.req.param("name"), body);
    if (result.kind === "not-found") {
      return c.json({ error: "preset not found" }, 404);
    }
    if (result.kind === "conflict") {
      return c.json(
        { error: "preset changed on disk", data: result.document },
        409,
      );
    }
    return c.json({ data: result.document });
  });

  app.delete("/api/presets/:name", (c) => {
    const deleted = deletePreset(c.req.param("name"));
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });
}
