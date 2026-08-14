import type { Hono } from "hono";

import { listConfigStoreStates } from "../config-store/registry.js";

export function registerConfigRoutes(app: Hono) {
  app.get("/api/config/state", (c) => {
    const files = listConfigStoreStates();
    return c.json({
      data: {
        files,
        dirtyOnDisk: files.some((file) => file.dirtyOnDisk === true),
      },
    });
  });
}
