import {
  ApiProxyPlanPreviewRequestSchema,
  ApiProxyRouteExplainRequestSchema,
  ApiProxyServeRequestSchema,
  ApiProxySourceCreateSchema,
  ApiProxySourceUpdateSchema,
} from "@arriero/core";
import type { Hono } from "hono";

import { listInstances } from "../instances/repository.js";
import {
  listApiEndpointCatalog,
  listRemoteInstanceEndpoints,
  referencedRemoteEndpoints,
} from "../proxy/endpoints.js";
import { apiProxyInflight } from "../proxy/inflight.js";
import { getApiProxyPlanPreview } from "../proxy/idle-maintenance.js";
import { explainApiProxyRoute } from "../proxy/route-explain.js";
import { getApiProxyConfig } from "../proxy/repository.js";
import { readApiProxyRequestFile } from "../proxy/request-files.js";
import {
  apiProxyResponseCacheStats,
  clearApiProxyResponseCache,
} from "../proxy/response-cache.js";
import { getApiProxyRuntimeSnapshot } from "../proxy/runtime-snapshot.js";
import {
  createApiProxySource,
  deleteApiProxySource,
  getApiProxySource,
  listApiProxySources,
  updateApiProxySource,
} from "../proxy/sources.js";
import { serveApiProxyPinnedInstance } from "../proxy/serve-pinned.js";
import { apiProxyStats } from "../proxy/stats.js";
import { buildApiProxyTargetModelCatalog } from "../proxy/target-models.js";

export function registerProxyRoutes(app: Hono) {
  app.post("/api/proxy/serve", async (c) => {
    const parsed = ApiProxyServeRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return serveApiProxyPinnedInstance(c, parsed.data);
  });

  app.get("/api/proxy/config", (c) => {
    const proxyConfig = getApiProxyConfig();
    return c.json({
      data: {
        ...proxyConfig,
        endpoints: [
          ...listApiEndpointCatalog(listInstances()),
          ...referencedRemoteEndpoints(
            proxyConfig.targets.map((target) => target.endpointId),
          ),
        ],
      },
    });
  });

  app.get("/api/proxy/target-models", async (c) => {
    const includeManagerProxy = c.req.query("includeManagerProxy") === "1";
    return c.json({
      data: await buildApiProxyTargetModelCatalog(listInstances(), {
        includeManagerProxy,
      }),
    });
  });

  app.get("/api/proxy/remote-endpoints", async (c) => {
    return c.json({ data: await listRemoteInstanceEndpoints() });
  });

  app.get("/api/proxy/request-file", (c) => {
    const path = c.req.query("path") ?? "";
    const record = readApiProxyRequestFile(path);
    if (!record) {
      return c.json({ error: "request file not found" }, 404);
    }
    return c.json({ data: record });
  });

  app.get("/api/proxy/stats", (c) => {
    const hours = Number(c.req.query("hours") ?? 24);
    return c.json({
      data: apiProxyStats.snapshot(Number.isFinite(hours) ? hours : 24),
    });
  });

  app.get("/api/proxy/traces", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({
      data: apiProxyStats.recentTraces(Number.isFinite(limit) ? limit : 50),
    });
  });

  app.get("/api/proxy/cache", (c) => {
    return c.json({ data: apiProxyResponseCacheStats() });
  });

  app.delete("/api/proxy/cache", (c) => {
    clearApiProxyResponseCache();
    return c.json({ data: { cleared: true } });
  });

  app.get("/api/proxy/sources", (c) => {
    return c.json({ data: listApiProxySources() });
  });

  app.post("/api/proxy/sources", async (c) => {
    const parsed = ApiProxySourceCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({ data: createApiProxySource(parsed.data) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch("/api/proxy/sources/:id", async (c) => {
    const parsed = ApiProxySourceUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      const source = updateApiProxySource(c.req.param("id"), parsed.data);
      if (!source) {
        return c.json({ error: "proxy source not found" }, 404);
      }
      return c.json({ data: source });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/proxy/sources/:id", (c) => {
    const id = c.req.param("id");
    if (!getApiProxySource(id)) {
      return c.json({ data: { deleted: false } }, 404);
    }
    const deleted = deleteApiProxySource(id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });

  app.get("/api/proxy/runtime", async (c) => {
    try {
      const runtime = await getApiProxyRuntimeSnapshot();
      return c.json({ data: runtime.snapshot });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/proxy/inflight/:id", (c) => {
    const detail = apiProxyInflight.getDetail(c.req.param("id"));
    if (!detail) {
      return c.json({ error: "in-flight request not found" }, 404);
    }
    return c.json({ data: detail });
  });

  app.post("/api/proxy/inflight/:id/interrupt", (c) => {
    const status = apiProxyInflight.requestForceAnswer(c.req.param("id"));
    return c.json({ data: { status } });
  });

  app.post("/api/proxy/inflight/:id/finish", (c) => {
    const status = apiProxyInflight.requestFinish(c.req.param("id"));
    return c.json({ data: { status } });
  });

  app.post("/api/proxy/inflight/:id/cancel", (c) => {
    const status = apiProxyInflight.requestCancel(c.req.param("id"));
    return c.json({ data: { status } });
  });

  app.post("/api/proxy/route-explain", async (c) => {
    const parsed = ApiProxyRouteExplainRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    try {
      return c.json({ data: await explainApiProxyRoute(parsed.data) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/proxy/plan", async (c) => {
    const parsed = ApiProxyPlanPreviewRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    try {
      return c.json({ data: await getApiProxyPlanPreview(parsed.data) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });
}
