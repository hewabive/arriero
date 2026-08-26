import {
  BackgroundJobStatusSchema,
  BenchmarkPromptCreateSchema,
  BenchmarkPromptUpdateSchema,
  BenchmarkScenarioSchema,
  type BenchmarkRun,
} from "@arriero/core";
import type { Hono } from "hono";
import { z } from "zod";

import {
  BenchmarkConflictError,
  BenchmarkNotFoundError,
} from "../benchmark/errors.js";
import {
  createBenchmarkPrompt,
  deleteBenchmarkPrompt,
  listBenchmarkPromptMetas,
  listBenchmarkPrompts,
  updateBenchmarkPrompt,
} from "../benchmark/prompts.js";
import {
  deleteBenchmarkRun,
  getBenchmarkRun,
  listBenchmarkRuns,
  readBenchmarkRunEvents,
  readBenchmarkRunResult,
} from "../benchmark/repository.js";
import {
  cancelBenchmarkRun,
  getBenchmarkRunProgress,
  startBenchmarkRun,
  waitForBenchmarkRun,
} from "../benchmark/runner.js";
import { parseJsonBody } from "./validation.js";

const RunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: BackgroundJobStatusSchema.optional(),
  label: z.string().min(1).max(120).optional(),
});

const RunGetQuerySchema = z.object({
  waitMs: z.coerce.number().int().min(1).max(60000).optional(),
});

function errorStatus(error: unknown): 400 | 404 | 409 {
  if (error instanceof BenchmarkConflictError) return 409;
  if (error instanceof BenchmarkNotFoundError) return 404;
  return 400;
}

function withProgress(run: BenchmarkRun): BenchmarkRun {
  return run.status === "running"
    ? { ...run, progress: getBenchmarkRunProgress(run.id) }
    : run;
}

export function registerBenchmarkRoutes(app: Hono) {
  app.get("/api/benchmark/prompts", (c) => {
    if (c.req.query("meta") === "true") {
      return c.json({ data: listBenchmarkPromptMetas() });
    }
    return c.json({ data: listBenchmarkPrompts() });
  });

  app.post("/api/benchmark/prompts", async (c) => {
    const body = await parseJsonBody(c, BenchmarkPromptCreateSchema);
    try {
      return c.json({ data: createBenchmarkPrompt(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, errorStatus(error));
    }
  });

  app.put("/api/benchmark/prompts/:id", async (c) => {
    const body = await parseJsonBody(c, BenchmarkPromptUpdateSchema);
    try {
      const updated = updateBenchmarkPrompt(c.req.param("id"), body);
      if (!updated) {
        return c.json({ error: "benchmark prompt not found" }, 404);
      }
      return c.json({ data: updated });
    } catch (error) {
      return c.json({ error: (error as Error).message }, errorStatus(error));
    }
  });

  app.delete("/api/benchmark/prompts/:id", (c) => {
    try {
      if (!deleteBenchmarkPrompt(c.req.param("id"))) {
        return c.json({ error: "benchmark prompt not found" }, 404);
      }
      return c.json({ data: { deleted: true } });
    } catch (error) {
      return c.json({ error: (error as Error).message }, errorStatus(error));
    }
  });

  app.get("/api/benchmark/runs", (c) => {
    const parsed = RunListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const { limit, status, label } = parsed.data;
    return c.json({
      data: listBenchmarkRuns(limit, {
        ...(status !== undefined ? { status } : {}),
        ...(label !== undefined ? { label } : {}),
      }).map(withProgress),
    });
  });

  app.post("/api/benchmark/runs", async (c) => {
    const body = await parseJsonBody(c, BenchmarkScenarioSchema);
    try {
      return c.json({ data: startBenchmarkRun(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, errorStatus(error));
    }
  });

  app.get("/api/benchmark/runs/:id", async (c) => {
    const parsed = RunGetQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const id = c.req.param("id");
    let run = getBenchmarkRun(id);
    if (!run) {
      return c.json({ error: "benchmark run not found" }, 404);
    }
    if (parsed.data.waitMs !== undefined && run.status === "running") {
      await waitForBenchmarkRun(id, parsed.data.waitMs);
      run = getBenchmarkRun(id) ?? run;
    }
    return c.json({ data: withProgress(run) });
  });

  app.get("/api/benchmark/runs/:id/events", (c) => {
    const id = c.req.param("id");
    if (!getBenchmarkRun(id)) {
      return c.json({ error: "benchmark run not found" }, 404);
    }
    const events = readBenchmarkRunEvents(id);
    if (!events) {
      return c.json({ error: "benchmark run events are not available" }, 404);
    }
    return c.json({ data: events });
  });

  app.get("/api/benchmark/runs/:id/result", (c) => {
    const id = c.req.param("id");
    if (!getBenchmarkRun(id)) {
      return c.json({ error: "benchmark run not found" }, 404);
    }
    const result = readBenchmarkRunResult(id);
    if (!result) {
      return c.json({ error: "benchmark run result is not available" }, 404);
    }
    return c.json({ data: result });
  });

  app.post("/api/benchmark/runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    const run = getBenchmarkRun(id);
    if (!run) {
      return c.json({ error: "benchmark run not found" }, 404);
    }
    if (run.status !== "running" || !cancelBenchmarkRun(id)) {
      return c.json({ error: "benchmark run is not running" }, 409);
    }
    return c.json({ data: { canceled: true } });
  });

  app.delete("/api/benchmark/runs/:id", (c) => {
    const id = c.req.param("id");
    const run = getBenchmarkRun(id);
    if (!run) {
      return c.json({ error: "benchmark run not found" }, 404);
    }
    if (run.status === "running") {
      return c.json({ error: "benchmark run is still running" }, 409);
    }
    deleteBenchmarkRun(id);
    return c.json({ data: { deleted: true } });
  });
}
