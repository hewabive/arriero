import { MemoryEstimateRequestSchema } from "@arriero/core";
import type { Hono } from "hono";

import { createMemoryAssessment } from "../memory-assessment/service.js";
import { estimateMemory } from "../memory-estimate/service.js";
import { parseJsonBody } from "./validation.js";

export function registerMemoryEstimateRoutes(app: Hono) {
  app.post("/api/memory-estimate", async (c) => {
    const body = await parseJsonBody(c, MemoryEstimateRequestSchema);
    const result = await estimateMemory(body);
    if (!result.ok) {
      return c.json({ error: result.reason }, 422);
    }
    const assessmentId = createMemoryAssessment(result);
    return c.json({
      data: {
        modelPath: result.modelPath,
        estimate: result.estimate,
        assessmentId,
      },
    });
  });
}
