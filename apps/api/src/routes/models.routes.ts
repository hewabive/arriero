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
    const parsed = ModelScanRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
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
