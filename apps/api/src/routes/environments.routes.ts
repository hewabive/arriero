import { EnvironmentCreateSchema, EnvironmentEngineSchema } from "@arriero/core";
import type { Hono } from "hono";

import { resolveEnvironmentIndexVersions } from "../envs/index-versions.js";
import { tailEnvironmentLog } from "../envs/logs.js";
import { getEnvironmentJob, listEnvironmentJobs } from "../envs/repository.js";
import { environmentRunner } from "../envs/runner.js";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  rebuildEnvironment,
} from "../envs/service.js";

export function registerEnvironmentRoutes(app: Hono) {
  app.get("/api/environments", (c) => c.json({ data: listEnvironments() }));

  app.post("/api/environments", async (c) => {
    const parsed = EnvironmentCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: createEnvironment(parsed.data) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/environments/:id/rebuild", (c) => {
    try {
      const result = rebuildEnvironment(c.req.param("id"));
      return result
        ? c.json({ data: result }, 201)
        : c.json({ error: "environment not found" }, 404);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/environments/:id", (c) => {
    try {
      const deleted = deleteEnvironment(c.req.param("id"));
      return c.json({ data: { deleted } }, deleted ? 200 : 404);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/environments/index-versions", async (c) => {
    const engine = EnvironmentEngineSchema.safeParse(c.req.query("engine"));
    if (!engine.success) return c.json({ error: engine.error.flatten() }, 400);
    return c.json({
      data: await resolveEnvironmentIndexVersions({
        engine: engine.data,
        indexUrl: c.req.query("indexUrl") ?? null,
      }),
    });
  });

  app.get("/api/environments/jobs", (c) => {
    const limit = Number(c.req.query("limit") ?? "20");
    return c.json({
      data: listEnvironmentJobs(Number.isFinite(limit) ? limit : 20),
    });
  });

  app.post("/api/environments/jobs/:id/cancel", (c) => {
    const job = environmentRunner.cancel(c.req.param("id"));
    return job
      ? c.json({ data: job })
      : c.json({ error: "environment job not found" }, 404);
  });

  app.get("/api/environments/jobs/:id/logs", (c) => {
    const job = getEnvironmentJob(c.req.param("id"));
    if (!job) return c.json({ error: "environment job not found" }, 404);
    const lines = Number(c.req.query("lines") ?? "200");
    return c.json({
      data: tailEnvironmentLog(job.id, Number.isFinite(lines) ? lines : 200),
    });
  });
}
