import {
  probeReachableHost,
  webappDescriptor,
  WebappCreateSchema,
  WebappUpdateSchema,
  type WebappCreate,
  type WebappKind,
  type WebappRunInfo,
  type WebappUpdate,
} from "@arriero/core";
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";

import { getEnvironmentRecord } from "../envs/service.js";
import { requestJsonProbe } from "../instances/endpoint.js";
import {
  createApiProxySource,
  deleteApiProxySource,
  getApiProxySource,
} from "../proxy/sources.js";
import { parsePidText } from "../process/pid.js";
import { getWebappRecord } from "../webapps/config-files.js";
import { tailWebappLog } from "../webapps/logs.js";
import { checkWebappStartPreflight } from "../webapps/preflight.js";
import {
  createWebapp,
  deleteWebapp,
  getWebapp,
  listWebapps,
  updateWebapp,
  WebappConfigValidationError,
  WebappNameConflictError,
  WebappUpdateBlockedError,
} from "../webapps/repository.js";
import {
  latestWebappRun,
  listWebappRuns,
  type WebappRun,
} from "../webapps/runs-repository.js";
import {
  restartWebapp,
  startWebapp,
  stopWebapp,
  stopWebappForDelete,
  WebappStartBlockedError,
} from "../webapps/service.js";
import { webappSupervisor } from "../webapps/supervisor.js";

function validateWebappRefs(input: {
  kind: WebappKind;
  envSpecId?: string | undefined;
  proxySourceId?: string | null | undefined;
}): string | null {
  if (input.envSpecId !== undefined) {
    const environment = getEnvironmentRecord(input.envSpecId);
    if (!environment) {
      return "environment spec not found";
    }
    const expectedEngine = webappDescriptor(input.kind).environmentEngine;
    if (environment.engine !== expectedEngine) {
      return `environment engine ${environment.engine} does not match webapp kind ${input.kind}`;
    }
  }
  if (input.proxySourceId && !getApiProxySource(input.proxySourceId)) {
    return "proxy source not found";
  }
  return null;
}

function latestRunFallbackState(name: string, latestRun: WebappRun | null) {
  return {
    name,
    pid: latestRun ? parsePidText(latestRun.pid) : null,
    status: latestRun?.status ?? "stopped",
    startedAt: latestRun?.startedAt ?? null,
    stoppedAt: latestRun?.stoppedAt ?? null,
    exitCode:
      latestRun?.exitCode === null || latestRun?.exitCode === undefined
        ? null
        : Number(latestRun.exitCode),
    logPath: latestRun?.logPath ?? null,
    rawLogPath: latestRun?.rawLogPath ?? null,
    adopted: false,
  };
}

function toWebappRunInfo(run: WebappRun): WebappRunInfo {
  return {
    id: run.id,
    pid: parsePidText(run.pid),
    status: run.status as WebappRunInfo["status"],
    startedAt: run.startedAt,
    stoppedAt: run.stoppedAt,
    exitCode: run.exitCode === null ? null : Number(run.exitCode),
    adopted: run.adopted === "true",
    stopReason: run.stopReason ?? null,
    logPath: run.logPath,
    rawLogPath: run.rawLogPath,
  };
}

function createWebappProxySource(input: WebappCreate): string {
  const source = createApiProxySource({
    name: input.name,
    enabled: true,
    note: `API key for the ${webappDescriptor(input.kind).displayName} webapp "${input.name}"`,
    blockedMessage: "",
    apiKey: `arriero-${randomBytes(24).toString("hex")}`,
  });
  return source.id;
}

export function registerWebappRoutes(app: Hono) {
  app.get("/api/webapps", (c) => c.json({ data: listWebapps() }));

  app.post("/api/webapps", async (c) => {
    const parsed = WebappCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const refError = validateWebappRefs(parsed.data);
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    let proxySourceId: string | null = null;
    if (parsed.data.createProxySource) {
      try {
        proxySourceId = createWebappProxySource(parsed.data);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
    }
    try {
      return c.json({ data: createWebapp(parsed.data, proxySourceId) }, 201);
    } catch (error) {
      if (proxySourceId) {
        deleteApiProxySource(proxySourceId);
      }
      if (error instanceof WebappNameConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof WebappConfigValidationError) {
        return c.json({ error: error.details }, 400);
      }
      throw error;
    }
  });

  app.get("/api/webapps/:id", (c) => {
    const webapp = getWebapp(c.req.param("id"));
    if (!webapp) {
      return c.json({ error: "webapp not found" }, 404);
    }
    return c.json({ data: webapp });
  });

  app.get("/api/webapps/:id/runtime", async (c) => {
    const record = getWebappRecord(c.req.param("id"));
    if (!record) {
      return c.json({ error: "webapp not found" }, 404);
    }
    const latestRun = latestWebappRun(record.name);
    const state =
      webappSupervisor.getState(record.name) ??
      latestRunFallbackState(record.name, latestRun);
    const health =
      state.status === "running"
        ? await requestJsonProbe(
            `http://${probeReachableHost(record.http.host)}:${record.http.port}${webappDescriptor(record.kind).probe.path}`,
          )
        : null;
    return c.json({
      data: { ...state, stopReason: latestRun?.stopReason ?? null, health },
    });
  });

  app.get("/api/webapps/:id/runs", (c) => {
    const record = getWebappRecord(c.req.param("id"));
    if (!record) {
      return c.json({ error: "webapp not found" }, 404);
    }
    const limit = Number(c.req.query("limit") ?? "20");
    return c.json({
      data: listWebappRuns(
        record.name,
        Number.isFinite(limit) ? limit : 20,
      ).map(toWebappRunInfo),
    });
  });

  app.get("/api/webapps/:id/preflight", async (c) => {
    const record = getWebappRecord(c.req.param("id"));
    if (!record) {
      return c.json({ error: "webapp not found" }, 404);
    }
    const state = webappSupervisor.getState(record.name);
    return c.json({
      data: {
        issues: await checkWebappStartPreflight(
          record,
          getEnvironmentRecord(record.envSpecId),
          { checkPort: state?.status !== "running" },
        ),
      },
    });
  });

  app.get("/api/webapps/:id/logs", (c) => {
    const record = getWebappRecord(c.req.param("id"));
    if (!record) {
      return c.json({ error: "webapp not found" }, 404);
    }
    const lines = Number(c.req.query("lines") ?? "200");
    const source = c.req.query("source") === "raw" ? "raw" : "filtered";
    return c.json({
      data: tailWebappLog({
        name: record.name,
        runtime: webappSupervisor.getState(record.name),
        lines: Number.isFinite(lines) ? lines : 200,
        source,
      }),
    });
  });

  app.post("/api/webapps/:id/start", async (c) => {
    try {
      const state = await startWebapp(c.req.param("id"));
      if (!state) {
        return c.json({ error: "webapp not found" }, 404);
      }
      return c.json({ data: state });
    } catch (error) {
      if (error instanceof WebappStartBlockedError) {
        return c.json({ error: error.message, issues: error.issues }, 409);
      }
      throw error;
    }
  });

  app.post("/api/webapps/:id/stop", async (c) => {
    const record = getWebappRecord(c.req.param("id"));
    if (!record) {
      return c.json({ error: "webapp not found" }, 404);
    }
    try {
      const state = await stopWebapp(record.name);
      return c.json({
        data:
          state ??
          latestRunFallbackState(record.name, latestWebappRun(record.name)),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/webapps/:id/restart", async (c) => {
    try {
      const state = await restartWebapp(c.req.param("id"));
      if (!state) {
        return c.json({ error: "webapp not found" }, 404);
      }
      return c.json({ data: state });
    } catch (error) {
      if (error instanceof WebappStartBlockedError) {
        return c.json({ error: error.message, issues: error.issues }, 409);
      }
      throw error;
    }
  });

  app.patch("/api/webapps/:id", async (c) => {
    const parsed = WebappUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const current = getWebappRecord(c.req.param("id"));
    if (!current) {
      return c.json({ error: "webapp not found" }, 404);
    }
    const refError = validateWebappRefs({
      kind: current.kind,
      ...(parsed.data as WebappUpdate),
    });
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    try {
      const webapp = updateWebapp(current.name, parsed.data);
      if (!webapp) {
        return c.json({ error: "webapp not found" }, 404);
      }
      return c.json({ data: webapp });
    } catch (error) {
      if (
        error instanceof WebappNameConflictError ||
        error instanceof WebappUpdateBlockedError
      ) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof WebappConfigValidationError) {
        return c.json({ error: error.details }, 400);
      }
      throw error;
    }
  });

  app.delete("/api/webapps/:id", async (c) => {
    const id = c.req.param("id");
    const record = getWebappRecord(id);
    try {
      await stopWebappForDelete(id);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const deleted = deleteWebapp(id);
    if (
      deleted &&
      record?.proxySourceId &&
      c.req.query("deleteProxySource") === "true"
    ) {
      deleteApiProxySource(record.proxySourceId);
    }
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });
}
