import {
  MAX_WORKLOAD_PROFILE_WINDOWS,
  WorkloadDatasetFreezeRequestSchema,
  WorkloadDatasetSelectionSchema,
  WorkloadLinkingQuerySchema,
  WorkloadProfileQuerySchema,
  WorkloadSessionListQuerySchema,
  type WorkloadProfile,
  type WorkloadProfileQuery,
} from "@arriero/core";
import type { Hono } from "hono";

import {
  deleteWorkloadDataset,
  describeWorkloadDataset,
  listWorkloadDatasets,
  readWorkloadDatasetManifest,
  workloadDatasetBytes,
} from "../workload/dataset-store.js";
import {
  WorkloadImportError,
  importWorkloadDataset,
  workloadDatasetExportFileName,
  workloadDatasetExportStream,
} from "../workload/dataset-transfer.js";
import {
  WorkloadFreezeConflictError,
  WorkloadSelectionError,
  currentWorkloadFreezeJob,
  previewWorkloadSelection,
  startWorkloadDatasetFreeze,
} from "../workload/freeze.js";
import {
  buildWorkloadProfile,
  summarizeWorkloadSession,
  workloadLinkingGroups,
  workloadProfileWindowCount,
  type WorkloadProfileRange,
} from "../workload/profile.js";
import {
  listWorkloadRecords,
  listWorkloadSessionRecords,
  listWorkloadSessions,
  workloadIndexStatus,
} from "../workload/repository.js";
import { parseJsonBody } from "./validation.js";

const DEFAULT_PROFILE_SPAN_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type ResolvedRange =
  | { ok: true; range: WorkloadProfileRange }
  | { ok: false; error: string };

type ProfileResult =
  | { ok: true; profile: WorkloadProfile }
  | { ok: false; error: string };

function resolveProfileRange(
  query: WorkloadProfileQuery,
  now: number,
): ResolvedRange {
  const toMs = query.to === undefined ? now : Date.parse(query.to);
  const fromMs =
    query.from === undefined
      ? toMs - DEFAULT_PROFILE_SPAN_MS
      : Date.parse(query.from);
  if (fromMs >= toMs) {
    return { ok: false, error: "from must be earlier than to" };
  }
  const range = {
    fromMs,
    toMs,
    windowMs: query.windowMinutes * MINUTE_MS,
    stepMs: query.stepMinutes * MINUTE_MS,
  };
  if (workloadProfileWindowCount(range) > MAX_WORKLOAD_PROFILE_WINDOWS) {
    return {
      ok: false,
      error: `the range produces more than ${MAX_WORKLOAD_PROFILE_WINDOWS} windows; use a longer step`,
    };
  }
  return { ok: true, range };
}

function profileForQuery(query: WorkloadProfileQuery): ProfileResult {
  const resolved = resolveProfileRange(query, Date.now());
  if (!resolved.ok) {
    return resolved;
  }
  const { range } = resolved;
  const from = new Date(range.fromMs).toISOString();
  const to = new Date(range.toMs).toISOString();
  const records = listWorkloadRecords({
    from,
    to,
    sourceId: query.sourceId,
    modelId: query.modelId,
    targetId: query.targetId,
  });
  return {
    ok: true,
    profile: {
      from,
      to,
      windowMinutes: query.windowMinutes,
      stepMinutes: query.stepMinutes,
      ...buildWorkloadProfile(records, range),
    },
  };
}

export function registerWorkloadRoutes(app: Hono) {
  app.get("/api/workload/index", (c) =>
    c.json({ data: workloadIndexStatus() }),
  );

  app.get("/api/workload/sessions", (c) => {
    const parsed = WorkloadSessionListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const query = parsed.data;
    return c.json({
      data: listWorkloadSessions({
        from: query.from,
        to: query.to,
        sourceId: query.sourceId,
        modelId: query.modelId,
        targetId: query.targetId,
        before:
          query.beforeAt !== undefined && query.beforeId !== undefined
            ? { at: query.beforeAt, sessionId: query.beforeId }
            : undefined,
        limit: query.limit,
      }),
    });
  });

  app.get("/api/workload/sessions/:id", (c) => {
    const records = listWorkloadSessionRecords(c.req.param("id"));
    const summary = summarizeWorkloadSession(records);
    if (!summary) {
      return c.json({ error: "workload session not found" }, 404);
    }
    return c.json({ data: { summary, records } });
  });

  app.get("/api/workload/profile", (c) => {
    const parsed = WorkloadProfileQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const result = profileForQuery(parsed.data);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ data: result.profile });
  });

  app.get("/api/workload/linking", (c) => {
    const parsed = WorkloadLinkingQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const status = workloadIndexStatus();
    const from =
      parsed.data.from ?? status.oldestAt ?? new Date().toISOString();
    const to = parsed.data.to ?? new Date().toISOString();
    return c.json({
      data: {
        from,
        to,
        groups: workloadLinkingGroups(listWorkloadRecords({ from, to })),
      },
    });
  });

  app.post("/api/workload/selection", async (c) => {
    const selection = await parseJsonBody(c, WorkloadDatasetSelectionSchema);
    return c.json({ data: previewWorkloadSelection(selection) });
  });

  app.post("/api/workload/datasets", async (c) => {
    const request = await parseJsonBody(c, WorkloadDatasetFreezeRequestSchema);
    try {
      return c.json({ data: startWorkloadDatasetFreeze(request) }, 202);
    } catch (error) {
      if (error instanceof WorkloadSelectionError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof WorkloadFreezeConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get("/api/workload/datasets/freeze", (c) =>
    c.json({ data: currentWorkloadFreezeJob() }),
  );

  app.post("/api/workload/datasets/import", async (c) => {
    const body = c.req.raw.body;
    if (!body) {
      return c.json({ error: "the request has no body" }, 400);
    }
    try {
      const result = await importWorkloadDataset(body);
      return c.json({ data: result }, result.imported ? 201 : 200);
    } catch (error) {
      if (error instanceof WorkloadImportError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.get("/api/workload/datasets", async (c) =>
    c.json({ data: await listWorkloadDatasets() }),
  );

  app.get("/api/workload/datasets/:id", async (c) => {
    const manifest = readWorkloadDatasetManifest(c.req.param("id"));
    if (!manifest) {
      return c.json({ error: "workload dataset not found" }, 404);
    }
    return c.json({
      data: describeWorkloadDataset(
        manifest,
        await workloadDatasetBytes(manifest.id),
      ),
    });
  });

  app.delete("/api/workload/datasets/:id", (c) => {
    if (!deleteWorkloadDataset(c.req.param("id"))) {
      return c.json({ error: "workload dataset not found" }, 404);
    }
    return c.json({ data: { deleted: true } });
  });

  app.get("/api/workload/datasets/:id/export", (c) => {
    const manifest = readWorkloadDatasetManifest(c.req.param("id"));
    if (!manifest) {
      return c.json({ error: "workload dataset not found" }, 404);
    }
    return new Response(workloadDatasetExportStream(manifest), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${workloadDatasetExportFileName(manifest)}"`,
      },
    });
  });
}
