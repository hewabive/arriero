import {
  SourceRepositoryCloneSchema,
  SourceRepositoryIdSchema,
  SourceRepositorySettingsUpdateSchema,
} from "@arriero/core";
import type { Context, Hono } from "hono";

import { getSourceRepositoryDriftReport } from "../sources/drift.js";
import { updateSourceRepositorySettings } from "../sources/operations.js";
import {
  cancelSourceRepositoryOperationJob,
  getSourceRepositoryOperationJob,
  startSourceRepositoryClone,
  startSourceRepositoryPull,
} from "../sources/jobs.js";
import {
  getSourceRepositoryStatus,
  listSourceRepositoryStatuses,
} from "../sources/repository.js";

async function input(c: Context) {
  return c.req.json().catch(() => ({}));
}

function sourceId(c: Context): string {
  return SourceRepositoryIdSchema.parse(c.req.param("id"));
}

export function sourceRepositoryFailure(c: Context, error: unknown) {
  const message = (error as Error).message;
  if (/has no drift adapter/.test(message)) {
    return c.json({ error: message }, 404);
  }
  if (
    /already running|while a build|while configuration Git|no source repository operation is running/.test(
      message,
    )
  ) {
    return c.json({ error: message }, 409);
  }
  return c.json({ error: message }, 400);
}

export function registerSourceRepositoryRoutes(app: Hono) {
  app.get("/api/source-repositories", async (c) => {
    return c.json({ data: await listSourceRepositoryStatuses() });
  });

  app.get("/api/source-repositories/:id/status", async (c) => {
    try {
      return c.json({ data: await getSourceRepositoryStatus(sourceId(c)) });
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });

  app.get("/api/source-repositories/:id/operation", (c) => {
    try {
      return c.json({
        data: getSourceRepositoryOperationJob(sourceId(c)),
      });
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });

  app.get("/api/source-repositories/:id/drift", async (c) => {
    try {
      return c.json({
        data: await getSourceRepositoryDriftReport(sourceId(c)),
      });
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });

  app.put("/api/source-repositories/:id/settings", async (c) => {
    const parsed = SourceRepositorySettingsUpdateSchema.safeParse(
      await input(c),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({
        data: await updateSourceRepositorySettings(sourceId(c), parsed.data),
      });
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });

  app.post("/api/source-repositories/:id/clone", async (c) => {
    const parsed = SourceRepositoryCloneSchema.safeParse(await input(c));
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json(
        { data: startSourceRepositoryClone(sourceId(c), parsed.data) },
        202,
      );
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });

  app.post("/api/source-repositories/:id/pull", async (c) => {
    try {
      return c.json({ data: startSourceRepositoryPull(sourceId(c)) }, 202);
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });

  app.post("/api/source-repositories/:id/operation/cancel", (c) => {
    try {
      return c.json({
        data: cancelSourceRepositoryOperationJob(sourceId(c)),
      });
    } catch (error) {
      return sourceRepositoryFailure(c, error);
    }
  });
}
