import {
  BenchmarkPromptCreateSchema,
  BenchmarkPromptUpdateSchema,
  BenchmarkScenarioSchema,
  type BenchmarkRun,
} from "@arriero/core";
import type { Hono } from "hono";
import { z } from "zod";

import {
  createBenchmarkPrompt,
  deleteBenchmarkPrompt,
  listBenchmarkPrompts,
  updateBenchmarkPrompt,
} from "../benchmark/prompts.js";
import {
  deleteBenchmarkRun,
  getBenchmarkRun,
  listBenchmarkRuns,
  readBenchmarkRunResult,
} from "../benchmark/repository.js";
import {
  cancelBenchmarkRun,
  getBenchmarkRunProgress,
  startBenchmarkRun,
} from "../benchmark/runner.js";

const RunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CONFLICT_MESSAGE = /already active|already exists|builtin/;
const NOT_FOUND_MESSAGE = /not found/;

function errorStatus(message: string): 400 | 404 | 409 {
  if (CONFLICT_MESSAGE.test(message)) return 409;
  if (NOT_FOUND_MESSAGE.test(message)) return 404;
  return 400;
}

function withProgress(run: BenchmarkRun): BenchmarkRun {
  return run.status === "running"
    ? { ...run, progress: getBenchmarkRunProgress(run.id) }
    : run;
}

export function registerBenchmarkRoutes(app: Hono) {
  app.get("/api/benchmark/prompts", (c) => {
    return c.json({ data: listBenchmarkPrompts() });
  });

  app.post("/api/benchmark/prompts", async (c) => {
    const parsed = BenchmarkPromptCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({ data: createBenchmarkPrompt(parsed.data) }, 201);
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  app.put("/api/benchmark/prompts/:id", async (c) => {
    const parsed = BenchmarkPromptUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      const updated = updateBenchmarkPrompt(c.req.param("id"), parsed.data);
      if (!updated) {
        return c.json({ error: "benchmark prompt not found" }, 404);
      }
      return c.json({ data: updated });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  app.delete("/api/benchmark/prompts/:id", (c) => {
    try {
      if (!deleteBenchmarkPrompt(c.req.param("id"))) {
        return c.json({ error: "benchmark prompt not found" }, 404);
      }
      return c.json({ data: { deleted: true } });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  app.get("/api/benchmark/runs", (c) => {
    const parsed = RunListQuerySchema.safeParse({
      ...(c.req.query("limit") !== undefined
        ? { limit: c.req.query("limit") }
        : {}),
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({
      data: listBenchmarkRuns(parsed.data.limit).map(withProgress),
    });
  });

  app.post("/api/benchmark/runs", async (c) => {
    const parsed = BenchmarkScenarioSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({ data: startBenchmarkRun(parsed.data) }, 201);
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  app.get("/api/benchmark/runs/:id", (c) => {
    const run = getBenchmarkRun(c.req.param("id"));
    if (!run) {
      return c.json({ error: "benchmark run not found" }, 404);
    }
    return c.json({ data: withProgress(run) });
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
