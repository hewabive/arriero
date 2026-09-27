import {
  WorkloadProfileQuerySchema,
  WorkloadSessionListQuerySchema,
  WorkloadWindowRankingQuerySchema,
  type WorkloadProfileQuery,
} from "@arriero/core";
import type { Hono } from "hono";
import { z } from "zod";

import {
  MAX_WORKLOAD_PROFILE_WINDOWS,
  buildWorkloadProfile,
  rankWorkloadWindows,
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

const DEFAULT_PROFILE_SPAN_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const LinkingQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

type ResolvedRange =
  | { ok: true; range: WorkloadProfileRange }
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
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, error: "from and to must be ISO timestamps" };
  }
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

function rangeRecords(
  query: WorkloadProfileQuery,
  range: WorkloadProfileRange,
) {
  return listWorkloadRecords({
    from: new Date(range.fromMs).toISOString(),
    to: new Date(range.toMs).toISOString(),
    sourceId: query.sourceId,
    modelId: query.modelId,
    targetId: query.targetId,
  });
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
    const resolved = resolveProfileRange(parsed.data, Date.now());
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 400);
    }
    const { range } = resolved;
    const profile = buildWorkloadProfile(
      rangeRecords(parsed.data, range),
      range,
    );
    return c.json({
      data: {
        from: new Date(range.fromMs).toISOString(),
        to: new Date(range.toMs).toISOString(),
        windowMinutes: parsed.data.windowMinutes,
        stepMinutes: parsed.data.stepMinutes,
        ...profile,
      },
    });
  });

  app.get("/api/workload/windows", (c) => {
    const parsed = WorkloadWindowRankingQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const resolved = resolveProfileRange(parsed.data, Date.now());
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 400);
    }
    const { range } = resolved;
    const { windows } = buildWorkloadProfile(
      rangeRecords(parsed.data, range),
      range,
    );
    return c.json({
      data: rankWorkloadWindows(windows, parsed.data.rank, parsed.data.limit),
    });
  });

  app.get("/api/workload/linking", (c) => {
    const parsed = LinkingQuerySchema.safeParse(c.req.query());
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
}
