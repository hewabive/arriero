import { ExternalProcessKillSchema } from "@arriero/core";
import type { Hono } from "hono";

import { listFilesystemDirectory } from "../filesystem/browser.js";
import {
  killExternalLlamaProcess,
  listExternalLlamaProcesses,
} from "../process/external.js";
import { getPublicStatus } from "../public-status.js";
import { listNetworkInterfaceAddresses } from "../system/network.js";
import { getSystemResources } from "../system/resources.js";

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
    return c.json({ data: getSystemResources() });
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
