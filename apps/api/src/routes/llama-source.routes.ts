import {
  LlamaSourceCheckoutSchema,
  LlamaSourceSettingsUpdateSchema,
} from "@llama-manager/core";
import type { Hono } from "hono";

import { buildRunner } from "../build/runner.js";
import {
  checkoutLlamaSourceRef,
  getLlamaSourceSettings,
  getLlamaSourceStatus,
  listLlamaSourceRefs,
  pullLlamaSource,
  saveLlamaSourceSettings,
} from "../llama/source-repository.js";
import { getLlamaSourceSyncReport } from "../llama/source-sync.js";

export function registerLlamaSourceRoutes(app: Hono) {
  app.get("/api/llama-source/settings", (c) => {
    return c.json({ data: getLlamaSourceSettings() });
  });

  app.put("/api/llama-source/settings", async (c) => {
    const parsed = LlamaSourceSettingsUpdateSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (buildRunner.isRunning()) {
      return c.json(
        {
          error: "cannot change the llama.cpp source while a build is running",
        },
        409,
      );
    }
    try {
      return c.json({ data: saveLlamaSourceSettings(parsed.data) });
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        /source repository path while/.test(message) ? 409 : 400,
      );
    }
  });

  app.get("/api/llama-source/status", (c) => {
    return c.json({ data: getLlamaSourceStatus() });
  });

  app.get("/api/llama-source/refs", (c) => {
    return c.json({ data: listLlamaSourceRefs() });
  });

  app.get("/api/llama-source/sync", (c) => {
    try {
      return c.json({ data: getLlamaSourceSyncReport() });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/llama-source/checkout", async (c) => {
    const parsed = LlamaSourceCheckoutSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (buildRunner.isRunning()) {
      return c.json({ error: "cannot checkout while a build is running" }, 409);
    }
    try {
      return c.json({ data: await checkoutLlamaSourceRef(parsed.data.ref) });
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        /source operation is running/.test(message) ? 409 : 400,
      );
    }
  });

  app.post("/api/llama-source/pull", async (c) => {
    return c.json({ data: await pullLlamaSource() });
  });
}
