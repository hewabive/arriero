import { MemoryEstimateRequestSchema } from "@arriero/core";
import type { Hono } from "hono";

import { createMemoryAssessment } from "../memory-assessment/service.js";
import { estimateMemory } from "../memory-estimate/service.js";

export function registerMemoryEstimateRoutes(app: Hono) {
  app.post("/api/memory-estimate", async (c) => {
    const parsed = MemoryEstimateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const result = estimateMemory(parsed.data);
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
