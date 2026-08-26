import {
  LlamaSourceCheckoutSchema,
  LlamaSourceSettingsUpdateSchema,
} from "@arriero/core";
import type { Hono } from "hono";

import { buildRunner } from "../build/runner.js";
import {
  checkoutLlamaSourceRef,
  getLlamaSourceSettings,
  getLlamaSourceStatus,
  listLlamaSourceRefs,
  saveLlamaSourceSettings,
} from "../llama/source-repository.js";
import { startSourceRepositoryPull } from "../sources/jobs.js";
import { LLAMA_CPP_SOURCE_ID } from "../sources/registry.js";
import { getLlamaSourceSyncReport } from "../llama/source-sync.js";
import { sourceRepositoryFailure } from "./source-repositories.routes.js";
import { parseJsonBody } from "./validation.js";

export function registerLlamaSourceRoutes(app: Hono) {
  app.get("/api/llama-source/settings", (c) => {
    return c.json({ data: getLlamaSourceSettings() });
  });

  app.put("/api/llama-source/settings", async (c) => {
    const body = await parseJsonBody(c, LlamaSourceSettingsUpdateSchema);
    if (buildRunner.isRunning()) {
      return c.json(
        {
          error: "cannot change the llama.cpp source while a build is running",
        },
        409,
      );
    }
    try {
      return c.json({ data: saveLlamaSourceSettings(body) });
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        /source repository path while/.test(message) ? 409 : 400,
      );
    }
  });

  app.get("/api/llama-source/status", async (c) => {
    return c.json({ data: await getLlamaSourceStatus() });
  });

  app.get("/api/llama-source/refs", async (c) => {
    return c.json({ data: await listLlamaSourceRefs() });
  });

  app.get("/api/llama-source/sync", async (c) => {
    try {
      return c.json({ data: await getLlamaSourceSyncReport() });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/llama-source/checkout", async (c) => {
    const body = await parseJsonBody(c, LlamaSourceCheckoutSchema);
    if (buildRunner.isRunning()) {
      return c.json({ error: "cannot checkout while a build is running" }, 409);
    }
    try {
      return c.json({ data: await checkoutLlamaSourceRef(body.ref) });
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        /source operation is running/.test(message) ? 409 : 400,
      );
    }
  });

  app.post("/api/llama-source/pull", async (c) => {
    try {
      return c.json(
        { data: startSourceRepositoryPull(LLAMA_CPP_SOURCE_ID) },
        202,
      );
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });
}
