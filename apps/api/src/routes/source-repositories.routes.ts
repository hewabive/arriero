import {
  SourceRepositoryCloneSchema,
  SourceRepositoryIdSchema,
  SourceRepositorySettingsUpdateSchema,
} from "@llama-manager/core";
import type { Context, Hono } from "hono";

import { config } from "../config.js";
import { getSourceRepositoryDriftReport } from "../sources/drift.js";
import {
  cloneSourceRepository,
  pullSourceRepository,
  updateSourceRepositorySettings,
} from "../sources/operations.js";
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

function failure(c: Context, error: unknown) {
  const message = (error as Error).message;
  if (/has no drift adapter/.test(message)) {
    return c.json({ error: message }, 404);
  }
  if (/already running|while a build|while configuration Git/.test(message)) {
    return c.json({ error: message }, 409);
  }
  return c.json({ error: message }, 400);
}

export function registerSourceRepositoryRoutes(app: Hono) {
  app.use("/api/source-repositories/*", async (c, next) => {
    const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
    if (
      !loopback.has(config.host) &&
      !config.auth.password &&
      !config.auth.passwordHash
    ) {
      return c.json(
        {
          error:
            "source repository management is disabled on a non-loopback listener until admin authentication is configured",
        },
        403,
      );
    }
    await next();
  });

  app.get("/api/source-repositories", (c) => {
    return c.json({ data: listSourceRepositoryStatuses() });
  });

  app.get("/api/source-repositories/:id/status", (c) => {
    try {
      return c.json({ data: getSourceRepositoryStatus(sourceId(c)) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/api/source-repositories/:id/drift", (c) => {
    try {
      return c.json({ data: getSourceRepositoryDriftReport(sourceId(c)) });
    } catch (error) {
      return failure(c, error);
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
      return failure(c, error);
    }
  });

  app.post("/api/source-repositories/:id/clone", async (c) => {
    const parsed = SourceRepositoryCloneSchema.safeParse(await input(c));
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json(
        { data: await cloneSourceRepository(sourceId(c), parsed.data) },
        201,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/source-repositories/:id/pull", async (c) => {
    try {
      return c.json({
        data: await pullSourceRepository(sourceId(c)),
      });
    } catch (error) {
      return failure(c, error);
    }
  });
}
