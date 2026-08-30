import {
  HfDownloadDeleteSchema,
  HfDownloadFileSkipSchema,
  HfDownloadQueueReorderSchema,
  HfDownloadResumeSchema,
  HfDownloadSettingsSchema,
  HfDownloadStartSchema,
  HfTokenUpdateSchema,
  HfUpdateCheckRequestSchema,
  ModelRequirementCreateSchema,
  parseHfRepoInput,
} from "@arriero/core";
import type { Context, Hono } from "hono";

import { browseHfRepo } from "../hf/browse.js";
import { HfHubError, type HfErrorKind } from "../hf/client.js";
import { HfDownloadConflictError } from "../hf/download-plan.js";
import {
  cancelActiveHfDownload,
  clearHfDownloadHistory,
  enqueueHfDownload,
  getHfDownloadQueueState,
  pauseHfDownloadJob,
  removeHfDownloadQueueJob,
  reorderHfDownloadQueue,
  resumeHfDownloadJob,
  skipHfDownloadFiles,
  type HfQueueMutationResult,
} from "../hf/download-queue.js";
import {
  deleteHfDownload,
  HfDownloadBusyError,
  HfDownloadNotFoundError,
  HfDownloadVerifyError,
  listHfDownloads,
  verifyHfDownloadRedownloadable,
} from "../hf/downloads.js";
import {
  captureModelRequirement,
  deleteModelRequirement,
  listModelRequirementStatuses,
  removeModelRequirementForDeletedDownload,
  upsertModelRequirement,
} from "../hf/requirements.js";
import {
  defaultHfDestDir,
  hfDestCheck,
  HfDownloadRequestError,
} from "../hf/paths.js";
import { hfTokenConfigured, setHfToken } from "../hf/token.js";
import { runHfUpdateChecks } from "../hf/update-check.js";
import { getPathCatalogEntry } from "../path-catalog/repository.js";
import {
  getHfDownloadSettings,
  saveHfDownloadSettings,
} from "../settings/downloads.js";
import { parseJsonBody } from "./validation.js";

const HF_ERROR_STATUS: Record<HfErrorKind, 403 | 404 | 429 | 502> = {
  unauthorized: 403,
  gated: 403,
  "not-found": 404,
  "rate-limited": 429,
  upstream: 502,
  network: 502,
};

function hfErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof HfHubError) {
    return c.json({ error: error.message }, HF_ERROR_STATUS[error.kind]);
  }
  if (error instanceof HfDownloadRequestError) {
    return c.json({ error: error.message }, 400);
  }
  if (error instanceof HfDownloadConflictError) {
    return c.json({ error: error.message }, 409);
  }
  throw error;
}

function queueMutationResponse(
  c: Context,
  result: HfQueueMutationResult,
): Response {
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json({ data: result.state });
}

export function registerHfRoutes(app: Hono) {
  app.get("/api/hf/token", (c) => {
    return c.json({ data: { tokenConfigured: hfTokenConfigured() } });
  });

  app.put("/api/hf/token", async (c) => {
    const body = await parseJsonBody(c, HfTokenUpdateSchema);
    setHfToken(body.token);
    return c.json({ data: { tokenConfigured: hfTokenConfigured() } });
  });

  app.get("/api/hf/browse", async (c) => {
    const repoInput = c.req.query("repo") ?? "";
    const parsed = parseHfRepoInput(repoInput);
    if (!parsed) {
      return c.json(
        { error: `not a HuggingFace repo id or URL: ${repoInput}` },
        400,
      );
    }
    const revision = c.req.query("revision") || parsed.revision;
    try {
      return c.json({
        data: await browseHfRepo({
          repoId: parsed.repoId,
          revision: revision ?? null,
        }),
      });
    } catch (error) {
      return hfErrorResponse(c, error);
    }
  });

  app.get("/api/hf/dest-check", async (c) => {
    const dir = c.req.query("dir");
    if (dir) {
      return c.json({ data: await hfDestCheck(dir) });
    }
    const repo = c.req.query("repo");
    const parsed = repo ? parseHfRepoInput(repo) : null;
    if (!parsed) {
      return c.json({ error: "dir or repo query parameter is required" }, 400);
    }
    try {
      return c.json({
        data: await hfDestCheck(defaultHfDestDir(parsed.repoId)),
      });
    } catch (error) {
      return hfErrorResponse(c, error);
    }
  });

  app.get("/api/hf/downloads", async (c) => {
    return c.json({ data: await listHfDownloads() });
  });

  app.post("/api/hf/downloads", async (c) => {
    const body = await parseJsonBody(c, HfDownloadStartSchema);
    try {
      const job = await enqueueHfDownload(body);
      captureModelRequirement(job);
      return c.json({ data: job }, 201);
    } catch (error) {
      return hfErrorResponse(c, error);
    }
  });

  app.get("/api/hf/requirements", async (c) => {
    return c.json({ data: await listModelRequirementStatuses() });
  });

  app.post("/api/hf/requirements", async (c) => {
    const body = await parseJsonBody(c, ModelRequirementCreateSchema);
    return c.json({ data: upsertModelRequirement(body) }, 201);
  });

  app.delete("/api/hf/requirements/:id", (c) => {
    const deleted = deleteModelRequirement(c.req.param("id"));
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });

  app.post("/api/hf/downloads/check", async (c) => {
    const body = await parseJsonBody(c, HfUpdateCheckRequestSchema);
    return c.json({ data: await runHfUpdateChecks(body.dirs) });
  });

  app.post("/api/hf/downloads/delete", async (c) => {
    const body = await parseJsonBody(c, HfDownloadDeleteSchema);
    const { dir, paths, verifyUpstream } = body;
    try {
      if (verifyUpstream) {
        await verifyHfDownloadRedownloadable(dir, paths);
      }
      deleteHfDownload(dir, paths);
      if (body.removeRequirement) {
        removeModelRequirementForDeletedDownload(dir, paths ?? null);
      }
      return c.json({ data: { deleted: true } });
    } catch (error) {
      if (error instanceof HfDownloadNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof HfDownloadBusyError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof HfDownloadVerifyError) {
        return c.json(
          { error: error.message, verification: error.verification },
          412,
        );
      }
      return hfErrorResponse(c, error);
    }
  });

  app.get("/api/hf/download-settings", (c) => {
    return c.json({ data: getHfDownloadSettings() });
  });

  app.put("/api/hf/download-settings", async (c) => {
    const body = await parseJsonBody(c, HfDownloadSettingsSchema);
    if (body.modelDirectoryId) {
      const entry = getPathCatalogEntry(body.modelDirectoryId);
      if (entry?.kind !== "models-dir") {
        return c.json({ error: "model directory not found" }, 400);
      }
    }
    return c.json({ data: saveHfDownloadSettings(body) });
  });

  app.get("/api/hf/queue", (c) => {
    return c.json({ data: getHfDownloadQueueState() });
  });

  app.post("/api/hf/queue/reorder", async (c) => {
    const body = await parseJsonBody(c, HfDownloadQueueReorderSchema);
    return queueMutationResponse(c, reorderHfDownloadQueue(body.ids));
  });

  app.delete("/api/hf/queue/history", (c) => {
    return c.json({ data: clearHfDownloadHistory() });
  });

  app.post("/api/hf/queue/:id/cancel", (c) => {
    return queueMutationResponse(c, cancelActiveHfDownload(c.req.param("id")));
  });

  app.post("/api/hf/queue/:id/pause", (c) => {
    return queueMutationResponse(c, pauseHfDownloadJob(c.req.param("id")));
  });

  app.post("/api/hf/queue/:id/resume", async (c) => {
    const parsed = HfDownloadResumeSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return queueMutationResponse(
      c,
      resumeHfDownloadJob(c.req.param("id"), {
        ignoreSlowEta: parsed.data.ignoreSlowEta ?? false,
      }),
    );
  });

  app.delete("/api/hf/queue/:id", (c) => {
    return queueMutationResponse(
      c,
      removeHfDownloadQueueJob(c.req.param("id")),
    );
  });

  app.post("/api/hf/queue/:id/files/skip", async (c) => {
    const body = await parseJsonBody(c, HfDownloadFileSkipSchema);
    return queueMutationResponse(
      c,
      skipHfDownloadFiles(c.req.param("id"), body.paths),
    );
  });
}
