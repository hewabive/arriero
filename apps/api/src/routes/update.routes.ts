import { UpdateJobStartSchema } from "@llama-manager/core";
import type { Hono } from "hono";

import { updateFleet } from "../update/fleet.js";
import { tailUpdateLog } from "../update/logs.js";
import { getUpdateJob, latestUpdateJob } from "../update/repository.js";
import { updateRunner } from "../update/runner.js";
import { checkForUpdate, getAppVersion } from "../update/version.js";

export function registerUpdateRoutes(app: Hono) {
  app.get("/api/version", (c) => {
    return c.json({ data: getAppVersion() });
  });

  app.get("/api/update/fleet", async (c) => {
    return c.json({ data: await updateFleet() });
  });

  app.post("/api/update/check", async (c) => {
    const { version, fetchError } = await checkForUpdate();
    return c.json({ data: version, fetchError });
  });

  app.get("/api/update/latest", (c) => {
    return c.json({ data: latestUpdateJob() });
  });

  app.post("/api/update", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateJobStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({ data: updateRunner.start(parsed.data) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/update/jobs/:id", (c) => {
    const job = getUpdateJob(c.req.param("id"));
    if (!job) {
      return c.json({ error: "update job not found" }, 404);
    }
    return c.json({ data: job });
  });

  app.post("/api/update/jobs/:id/cancel", (c) => {
    const job = updateRunner.cancel(c.req.param("id"));
    if (!job) {
      return c.json({ error: "update job not found" }, 404);
    }
    return c.json({ data: job });
  });

  app.get("/api/update/jobs/:id/logs", (c) => {
    const job = getUpdateJob(c.req.param("id"));
    if (!job) {
      return c.json({ error: "update job not found" }, 404);
    }
    const lines = Number(c.req.query("lines") ?? "200");
    return c.json({
      data: tailUpdateLog(job.id, Number.isFinite(lines) ? lines : 200),
    });
  });
}
