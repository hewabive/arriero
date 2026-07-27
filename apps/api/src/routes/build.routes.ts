import { BuildJobStartSchema, BuildSettingsSchema } from "@arriero/core";
import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defaultBinaryPath } from "../arguments/catalog.js";
import { tailBuildLog } from "../build/logs.js";
import {
  getBuildJob,
  getBuildSettings,
  listBuildJobs,
  saveBuildSettings,
} from "../build/repository.js";
import { buildRunner } from "../build/runner.js";
import { listPathCatalogEntries } from "../path-catalog/repository.js";

export function registerBuildRoutes(app: Hono) {
  app.get("/api/build/default-binary", (c) => {
    const path = defaultBinaryPath();
    const entry =
      listPathCatalogEntries("binary").find((item) => item.path === path) ??
      null;
    return c.json({
      data: { path, refId: entry?.id ?? null, exists: existsSync(path) },
    });
  });

  app.get("/api/build/settings", (c) => {
    return c.json({ data: getBuildSettings() });
  });

  app.put("/api/build/settings", async (c) => {
    const parsed = BuildSettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (
      buildRunner.isRunning() &&
      resolve(parsed.data.repoPath) !== resolve(getBuildSettings().repoPath)
    ) {
      return c.json(
        {
          error: "cannot change the llama.cpp source while a build is running",
        },
        409,
      );
    }
    try {
      return c.json({ data: saveBuildSettings(parsed.data) });
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        /source repository path while/.test(message) ? 409 : 400,
      );
    }
  });

  app.get("/api/build/jobs", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    return c.json({ data: listBuildJobs(Number.isFinite(limit) ? limit : 20) });
  });

  app.get("/api/build/jobs/:id", (c) => {
    const job = getBuildJob(c.req.param("id"));
    if (!job) {
      return c.json({ error: "build job not found" }, 404);
    }
    return c.json({ data: job });
  });

  app.post("/api/build/jobs", async (c) => {
    const parsed = BuildJobStartSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    try {
      return c.json({ data: await buildRunner.start(parsed.data) }, 201);
    } catch (error) {
      const message = (error as Error).message;
      return c.json(
        { error: message },
        /source operation.*running/.test(message) ? 409 : 400,
      );
    }
  });

  app.post("/api/build/jobs/:id/cancel", (c) => {
    const job = buildRunner.cancel(c.req.param("id"));
    if (!job) {
      return c.json({ error: "build job not found" }, 404);
    }
    return c.json({ data: job });
  });

  app.get("/api/build/jobs/:id/logs", (c) => {
    const job = getBuildJob(c.req.param("id"));
    if (!job) {
      return c.json({ error: "build job not found" }, 404);
    }

    const lines = Number(c.req.query("lines") ?? "200");
    return c.json({
      data: tailBuildLog(job.id, Number.isFinite(lines) ? lines : 200),
    });
  });
}
