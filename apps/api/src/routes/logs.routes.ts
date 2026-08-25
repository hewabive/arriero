import {
  LogRetentionSettingsSchema,
  type LogPruneResult,
  type LogStorageUsage,
} from "@arriero/core";
import type { Hono } from "hono";

import { getLogUsage, pruneManagedLogs } from "../logs/retention.js";
import { apiProxyRequestFilesUsage } from "../proxy/request-files.js";
import { pruneApiProxyTraceHistory } from "../proxy/traces-repository.js";
import {
  getLogRetentionSettings,
  saveLogRetentionSettings,
} from "../settings/logs.js";

export function registerLogRoutes(app: Hono) {
  app.get("/api/logs/settings", (c) =>
    c.json({ data: getLogRetentionSettings() }),
  );

  app.put("/api/logs/settings", async (c) => {
    const parsed = LogRetentionSettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: saveLogRetentionSettings(parsed.data) });
  });

  app.get("/api/logs/usage", (c) => {
    const usage: LogStorageUsage = {
      ...getLogUsage(),
      proxyRequests: apiProxyRequestFilesUsage(),
    };
    return c.json({ data: usage });
  });

  app.post("/api/logs/prune", (c) => {
    const logs = pruneManagedLogs();
    const traces = pruneApiProxyTraceHistory();
    const result: LogPruneResult = {
      deletedFiles: logs.deletedFiles,
      freedBytes: logs.freedBytes,
      prunedTraces: traces.prunedTraces,
      prunedRequestDirs: traces.prunedRequestDirs,
    };
    return c.json({ data: result });
  });
}
