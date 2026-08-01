import {
  ExternalProcessKillSchema,
  SystemMetricsWindowSchema,
} from "@arriero/core";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { listFilesystemDirectory } from "../filesystem/browser.js";
import { systemMetricsRecorder } from "../system/metrics-history.js";
import {
  killExternalLlamaProcess,
  listExternalLlamaProcesses,
} from "../process/external.js";
import { getPublicStatus } from "../public-status.js";
import { listNetworkInterfaceAddresses } from "../system/network.js";
import { getSystemResourcesWithBeeGfs } from "../system/resources.js";

const SYSTEM_METRICS_STREAM_BACKLOG = 300;

export function registerSystemRoutes(app: Hono) {
  app.get("/api/health", (c) => {
    return c.json({ ok: true, service: "arriero-api" });
  });

  app.get("/api/public/status", async (c) => {
    return c.json({ data: await getPublicStatus() });
  });

  app.get("/api/network/interfaces", (c) => {
    return c.json({ data: { interfaces: listNetworkInterfaceAddresses() } });
  });

  app.get("/api/system/resources", (c) => {
    return c.json({ data: getSystemResourcesWithBeeGfs() });
  });

  app.get("/api/system/metrics", (c) => {
    const parsed = SystemMetricsWindowSchema.safeParse(
      c.req.query("window") ?? "live",
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: systemMetricsRecorder.history(parsed.data) });
  });

  app.get("/api/system/metrics/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      const unsubscribe = systemMetricsRecorder.subscribe((sample) => {
        queue.push(JSON.stringify(sample));
        if (queue.length > SYSTEM_METRICS_STREAM_BACKLOG) {
          queue.splice(0, queue.length - SYSTEM_METRICS_STREAM_BACKLOG);
        }
      });

      stream.onAbort(unsubscribe);

      while (!stream.aborted) {
        const pending = queue.splice(0, queue.length);
        for (const data of pending) {
          await stream.writeSSE({ event: "sample", data });
        }
        await stream.sleep(500);
      }

      unsubscribe();
    });
  });

  app.get("/api/filesystem/list", (c) => {
    try {
      return c.json({
        data: listFilesystemDirectory(c.req.query("path")),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/system/llama-processes", async (c) => {
    return c.json({ data: await listExternalLlamaProcesses() });
  });

  app.post("/api/system/llama-processes/:pid/kill", async (c) => {
    const pid = Number(c.req.param("pid"));
    if (!Number.isInteger(pid) || pid < 1) {
      return c.json({ error: "invalid pid" }, 400);
    }

    const parsed = ExternalProcessKillSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    try {
      return c.json({
        data: await killExternalLlamaProcess(pid, parsed.data.force),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });
}
