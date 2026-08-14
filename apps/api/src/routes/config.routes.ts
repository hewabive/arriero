import type { Hono } from "hono";

import { applyConfigFromDisk } from "../config-git/apply.js";
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

  app.post("/api/config/reload", (c) => {
    try {
      const result = applyConfigFromDisk();
      if (!result.applied) {
        return c.json(
          { error: "configuration on disk is invalid", data: result },
          400,
        );
      }
      return c.json({ data: result });
    } catch (error) {
      const message = (error as Error).message;
      if (/while a build|while an environment|while a source/.test(message)) {
        return c.json({ error: message }, 409);
      }
      throw error;
    }
  });
}
