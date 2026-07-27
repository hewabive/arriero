import {
  FleetNodeCreateSchema,
  FleetNodeUpdateSchema,
  type FleetNode,
  type FleetNodeView,
} from "@arriero/core";
import type { Hono } from "hono";

import {
  createNode,
  deleteNode,
  getNode,
  listNodes,
  nodeHasToken,
  updateNode,
} from "../nodes/repository.js";
import { fleetResources, fleetSystem } from "../nodes/fleet.js";
import { localFederationCapabilities } from "../nodes/capabilities.js";
import { forwardToNode } from "../nodes/remote.js";
import { listRpcWorkerCandidates } from "../nodes/rpc-worker-catalog.js";

function toView(node: FleetNode): FleetNodeView {
  return { ...node, hasToken: nodeHasToken(node.id) };
}

export function registerNodeRoutes(app: Hono) {
  app.get("/api/federation/capabilities", (c) => {
    return c.json({ data: localFederationCapabilities() });
  });

  app.get("/api/fleet/system", async (c) => {
    return c.json({ data: await fleetSystem() });
  });

  app.get("/api/fleet/resources", async (c) => {
    return c.json({ data: await fleetResources() });
  });

  app.get("/api/fleet/rpc-workers", async (c) => {
    return c.json({ data: await listRpcWorkerCandidates() });
  });

  app.get("/api/nodes", (c) => {
    return c.json({ data: listNodes().map(toView) });
  });

  app.post("/api/nodes", async (c) => {
    const parsed = FleetNodeCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: toView(createNode(parsed.data)) }, 201);
  });

  app.patch("/api/nodes/:id", async (c) => {
    const parsed = FleetNodeUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const node = updateNode(c.req.param("id"), parsed.data);
    if (!node) {
      return c.json({ error: "node not found" }, 404);
    }
    return c.json({ data: toView(node) });
  });

  app.delete("/api/nodes/:id", (c) => {
    const deleted = deleteNode(c.req.param("id"));
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });

  app.all("/api/nodes/:id/*", async (c) => {
    const node = getNode(c.req.param("id"));
    if (!node) {
      return c.json({ error: "node not found" }, 404);
    }
    if (!node.enabled) {
      return c.json({ error: "node is disabled" }, 409);
    }
    try {
      return await forwardToNode(node, c);
    } catch (error) {
      return c.json(
        { error: `node ${node.name} unreachable: ${(error as Error).message}` },
        502,
      );
    }
  });
}
