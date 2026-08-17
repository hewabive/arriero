import {
  HfDownloadDeleteSchema,
  HfDownloadStartSchema,
  HfTokenUpdateSchema,
  HfUpdateCheckRequestSchema,
  parseHfRepoInput,
} from "@arriero/core";
import type { Context, Hono } from "hono";

import { browseHfRepo } from "../hf/browse.js";
import { HfHubError, type HfErrorKind } from "../hf/client.js";
import {
  cancelHfDownload,
  getHfDownloadJob,
  HfDownloadConflictError,
  listHfDownloadJobs,
  startHfDownload,
} from "../hf/download-runner.js";
import {
  deleteHfDownload,
  HfDownloadBusyError,
  HfDownloadNotFoundError,
  listHfDownloads,
} from "../hf/downloads.js";
import {
  defaultHfDestDir,
  hfDestCheck,
  HfDownloadRequestError,
} from "../hf/paths.js";
import { hfTokenConfigured, setHfToken } from "../hf/token.js";
import { runHfUpdateChecks } from "../hf/update-check.js";

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

export function registerHfRoutes(app: Hono) {
  app.get("/api/hf/token", (c) => {
    return c.json({ data: { tokenConfigured: hfTokenConfigured() } });
  });

  app.put("/api/hf/token", async (c) => {
    const parsed = HfTokenUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    setHfToken(parsed.data.token);
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
    const parsed = HfDownloadStartSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({ data: await startHfDownload(parsed.data) }, 201);
    } catch (error) {
      return hfErrorResponse(c, error);
    }
  });

  app.post("/api/hf/downloads/check", async (c) => {
    const parsed = HfUpdateCheckRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: await runHfUpdateChecks(parsed.data.dirs) });
  });

  app.post("/api/hf/downloads/delete", async (c) => {
    const parsed = HfDownloadDeleteSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      deleteHfDownload(parsed.data.dir);
      return c.json({ data: { deleted: true } });
    } catch (error) {
      if (error instanceof HfDownloadNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof HfDownloadBusyError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get("/api/hf/jobs", (c) => {
    return c.json({ data: listHfDownloadJobs() });
  });

  app.get("/api/hf/jobs/:owner/:repo", (c) => {
    const repoId = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const job = getHfDownloadJob(repoId);
    if (!job) {
      return c.json({ error: `no download job for ${repoId}` }, 404);
    }
    return c.json({ data: job });
  });

  app.post("/api/hf/jobs/:owner/:repo/cancel", (c) => {
    const repoId = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const job = cancelHfDownload(repoId);
    if (!job) {
      return c.json({ error: `no running download job for ${repoId}` }, 404);
    }
    return c.json({ data: job });
  });
}
