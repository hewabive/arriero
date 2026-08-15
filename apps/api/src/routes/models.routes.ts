import { ModelScanRequestSchema, ModelScanSettingsSchema } from "@arriero/core";
import type { Hono } from "hono";

import {
  getModelScanSettings,
  saveModelScanSettings,
} from "../models/cache-repository.js";
import { getModelScanView, startModelScan } from "../models/scan-runner.js";

export function registerModelRoutes(app: Hono) {
  app.get("/api/models", (c) => {
    return c.json({ data: getModelScanView() });
  });

  app.post("/api/models/scan", async (c) => {
    const body = await c.req.text();
    let payload: unknown = {};
    if (body.trim()) {
      try {
        payload = JSON.parse(body);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    }
    const parsed = ModelScanRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: startModelScan(parsed.data) });
  });

  app.get("/api/model-scan-settings", (c) => {
    return c.json({ data: getModelScanSettings() });
  });

  app.put("/api/model-scan-settings", async (c) => {
    const parsed = ModelScanSettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: saveModelScanSettings(parsed.data) });
  });
}
