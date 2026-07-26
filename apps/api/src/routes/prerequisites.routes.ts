import type { Hono } from "hono";

import { resetUvToolStatusCache } from "../envs/uv.js";
import { resetNumaInterleaveCache } from "../numa/capability.js";
import { getPrerequisiteReport } from "../prerequisites/report.js";

export function registerPrerequisiteRoutes(app: Hono) {
  app.get("/api/prerequisites", async (c) => {
    resetUvToolStatusCache();
    resetNumaInterleaveCache();
    return c.json({ data: await getPrerequisiteReport() });
  });
}
