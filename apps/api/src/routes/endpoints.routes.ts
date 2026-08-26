import {
  ApiEndpointCreateSchema,
  ApiEndpointUpdateSchema,
} from "@arriero/core";
import type { Hono } from "hono";

import { listInstances } from "../instances/repository.js";
import {
  createApiEndpoint,
  deleteApiEndpoint,
  getExternalApiEndpoint,
  listApiEndpointCatalog,
  updateApiEndpoint,
} from "../proxy/endpoints.js";
import { listApiProxyTargets } from "../proxy/repository.js";
import { isManagerProxyBaseUrl } from "../proxy/targets.js";
import { parseJsonBody } from "./validation.js";

function validateApiEndpointRefs(input: { baseUrl?: string | undefined }) {
  if (input.baseUrl && isManagerProxyBaseUrl(input.baseUrl)) {
    return "external API endpoint cannot point to arriero proxy itself";
  }
  return null;
}

export function registerEndpointRoutes(app: Hono) {
  app.get("/api/endpoints", (c) => {
    return c.json({ data: listApiEndpointCatalog(listInstances()) });
  });

  app.post("/api/endpoints", async (c) => {
    const body = await parseJsonBody(c, ApiEndpointCreateSchema);
    const refError = validateApiEndpointRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }

    try {
      return c.json({ data: createApiEndpoint(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch("/api/endpoints/:id", async (c) => {
    const body = await parseJsonBody(c, ApiEndpointUpdateSchema);
    const refError = validateApiEndpointRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }

    try {
      const endpoint = updateApiEndpoint(c.req.param("id"), body);
      if (!endpoint) {
        return c.json({ error: "API endpoint not found" }, 404);
      }
      return c.json({ data: endpoint });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/endpoints/:id", (c) => {
    const id = c.req.param("id");
    const endpoint = getExternalApiEndpoint(id);
    if (!endpoint) {
      return c.json({ data: { deleted: false } }, 404);
    }
    const usedBy = listApiProxyTargets().filter(
      (target) => target.endpointId === id,
    );
    if (usedBy.length > 0) {
      return c.json(
        { error: `API endpoint is used by ${usedBy.length} proxy target(s)` },
        400,
      );
    }
    const deleted = deleteApiEndpoint(id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });
}
