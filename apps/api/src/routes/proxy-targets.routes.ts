import {
  ApiProxyModelCreateSchema,
  ApiProxyModelUpdateSchema,
  ApiProxyPipelineCreateSchema,
  ApiProxyPipelineUpdateSchema,
  ApiProxyQuickRouteCreateSchema,
  ApiProxyTargetCreateSchema,
  ApiProxyTargetUpdateSchema,
  type ApiProxyPipelineRecord,
  type ApiProxyRouteTo,
} from "@arriero/core";
import type { Hono } from "hono";

import { listInstances } from "../instances/repository.js";
import { getApiEndpointById } from "../proxy/endpoints.js";
import {
  collectApiProxyPipelineRefs,
  validateApiProxyModelRouteBinding,
  validateApiProxyPipelineGraph,
  validateApiProxyPipelineRouteCompleteness,
  type ApiProxyPipelineGraph,
} from "../proxy/pipeline-validation.js";
import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyQuickRoute,
  createApiProxyTarget,
  deleteApiProxyModel,
  deleteApiProxyPipeline,
  deleteApiProxyTarget,
  getApiProxyModel,
  getApiProxyPipeline,
  getApiProxyTarget,
  listApiProxyModels,
  listApiProxyPipelines,
  updateApiProxyModel,
  updateApiProxyPipeline,
  updateApiProxyTarget,
} from "../proxy/repository.js";
import { parseJsonBody } from "./validation.js";

function validateApiProxyTargetRefs(input: {
  endpointId?: string | undefined;
}) {
  if (!input.endpointId) {
    return null;
  }
  const endpoint = getApiEndpointById(input.endpointId, listInstances());
  if (!endpoint) {
    return "proxy target endpoint not found";
  }
  if (endpoint.kind === "manager-proxy") {
    return "proxy target cannot point to arriero proxy itself";
  }
  return null;
}

function validateApiProxyTargetModel(input: {
  endpointId?: string | undefined;
  model?: string | null | undefined;
}) {
  if (!input.endpointId || !input.model) {
    return null;
  }
  const endpoint = getApiEndpointById(input.endpointId, listInstances());
  if (
    !endpoint ||
    endpoint.kind !== "managed-instance" ||
    !endpoint.instanceId
  ) {
    return null;
  }
  return `target ${endpoint.name} is a managed instance: leave the model empty (it is implied by the instance).`;
}

function validateApiProxyRouteToRef(input: {
  routeTo?: ApiProxyRouteTo | null | undefined;
}) {
  if (!input.routeTo) {
    return null;
  }
  if (input.routeTo.type === "target" && !getApiProxyTarget(input.routeTo.id)) {
    return "route target not found";
  }
  if (
    input.routeTo.type === "pipeline" &&
    !getApiProxyPipeline(input.routeTo.id)
  ) {
    return "route pipeline not found";
  }
  if (
    input.routeTo.type === "endpoint" &&
    !getApiEndpointById(input.routeTo.endpointId, listInstances())
  ) {
    return "route endpoint not found";
  }
  return null;
}

function validateApiProxyModelRefs(input: {
  targetId?: string | null | undefined;
  routeTo?: ApiProxyRouteTo | null | undefined;
}) {
  if (input.targetId && !getApiProxyTarget(input.targetId)) {
    return "proxy model target not found";
  }
  const refError = validateApiProxyRouteToRef(input);
  if (refError) {
    return refError;
  }
  return validateApiProxyModelRouteBinding({
    routeTo: input.routeTo,
    getPipeline: (id) => getApiProxyPipeline(id),
  });
}

const pipelineGraphContext = {
  getPipeline: (id: string) => getApiProxyPipeline(id),
  hasTarget: (id: string) => Boolean(getApiProxyTarget(id)),
};

function validateApiProxyPipelineGraphInput(graph: ApiProxyPipelineGraph) {
  return validateApiProxyPipelineGraph(graph, pipelineGraphContext);
}

function pipelineRefersToPipeline(
  pipeline: ApiProxyPipelineRecord,
  id: string,
) {
  return collectApiProxyPipelineRefs(pipeline).pipelineIds.has(id);
}

function pipelineRefersToTarget(pipeline: ApiProxyPipelineRecord, id: string) {
  return collectApiProxyPipelineRefs(pipeline).targetIds.has(id);
}

export function registerProxyTargetRoutes(app: Hono) {
  app.post("/api/proxy/models", async (c) => {
    const body = await parseJsonBody(c, ApiProxyModelCreateSchema);
    const refError = validateApiProxyModelRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }

    try {
      return c.json({ data: createApiProxyModel(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch("/api/proxy/models/:id", async (c) => {
    const body = await parseJsonBody(c, ApiProxyModelUpdateSchema);
    const refError = validateApiProxyModelRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }

    try {
      const model = updateApiProxyModel(c.req.param("id"), body);
      if (!model) {
        return c.json({ error: "proxy model not found" }, 404);
      }
      return c.json({ data: model });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/proxy/models/:id", (c) => {
    const model = getApiProxyModel(c.req.param("id"));
    if (!model) {
      return c.json({ data: { deleted: false } }, 404);
    }
    const deleted = deleteApiProxyModel(model.id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });

  app.post("/api/proxy/pipelines", async (c) => {
    const body = await parseJsonBody(c, ApiProxyPipelineCreateSchema);
    const graphError = validateApiProxyPipelineGraphInput({
      id: null,
      name: body.name,
      entry: body.entry,
      nodes: body.nodes,
    });
    if (graphError) {
      return c.json({ error: graphError }, 400);
    }

    try {
      return c.json({ data: createApiProxyPipeline(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch("/api/proxy/pipelines/:id", async (c) => {
    const body = await parseJsonBody(c, ApiProxyPipelineUpdateSchema);
    const current = getApiProxyPipeline(c.req.param("id"));
    if (!current) {
      return c.json({ error: "proxy pipeline not found" }, 404);
    }
    const candidate = {
      id: current.id,
      name: body.name ?? current.name,
      entry: body.entry !== undefined ? body.entry : current.entry,
      nodes: body.nodes ?? current.nodes,
    };
    const graphError = validateApiProxyPipelineGraphInput(candidate);
    if (graphError) {
      return c.json({ error: graphError }, 400);
    }
    const completenessError = validateApiProxyPipelineRouteCompleteness({
      candidate,
      models: listApiProxyModels(),
      getPipeline: (id) => getApiProxyPipeline(id),
    });
    if (completenessError) {
      return c.json({ error: completenessError }, 400);
    }

    try {
      const pipeline = updateApiProxyPipeline(current.id, body);
      if (!pipeline) {
        return c.json({ error: "proxy pipeline not found" }, 404);
      }
      return c.json({ data: pipeline });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/proxy/pipelines/:id", (c) => {
    const id = c.req.param("id");
    const usedByModels = listApiProxyModels().filter(
      (model) => model.routeTo?.type === "pipeline" && model.routeTo.id === id,
    );
    const usedByPipelines = listApiProxyPipelines().filter(
      (pipeline) =>
        pipeline.id !== id && pipelineRefersToPipeline(pipeline, id),
    );
    if (usedByModels.length + usedByPipelines.length > 0) {
      return c.json(
        {
          error: `proxy pipeline is used by ${usedByModels.length + usedByPipelines.length} route(s)`,
        },
        400,
      );
    }
    const deleted = deleteApiProxyPipeline(id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });

  app.post("/api/proxy/quick-route", async (c) => {
    const body = await parseJsonBody(c, ApiProxyQuickRouteCreateSchema);
    const refError = validateApiProxyTargetRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    const modelError = validateApiProxyTargetModel(body);
    if (modelError) {
      return c.json({ error: modelError }, 400);
    }

    try {
      return c.json({ data: createApiProxyQuickRoute(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/proxy/targets", async (c) => {
    const body = await parseJsonBody(c, ApiProxyTargetCreateSchema);
    const refError = validateApiProxyTargetRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    const modelError = validateApiProxyTargetModel(body);
    if (modelError) {
      return c.json({ error: modelError }, 400);
    }

    try {
      return c.json({ data: createApiProxyTarget(body) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.patch("/api/proxy/targets/:id", async (c) => {
    const body = await parseJsonBody(c, ApiProxyTargetUpdateSchema);
    const refError = validateApiProxyTargetRefs(body);
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    if ("model" in body) {
      const existing = getApiProxyTarget(c.req.param("id"));
      const modelError = validateApiProxyTargetModel({
        endpointId: body.endpointId ?? existing?.endpointId,
        model: body.model,
      });
      if (modelError) {
        return c.json({ error: modelError }, 400);
      }
    }

    try {
      const target = updateApiProxyTarget(c.req.param("id"), body);
      if (!target) {
        return c.json({ error: "proxy target not found" }, 404);
      }
      return c.json({ data: target });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete("/api/proxy/targets/:id", (c) => {
    const id = c.req.param("id");
    const usedByModels = listApiProxyModels().filter(
      (model) =>
        model.targetId === id ||
        (model.routeTo?.type === "target" && model.routeTo.id === id),
    );
    const usedByPipelines = listApiProxyPipelines().filter((pipeline) =>
      pipelineRefersToTarget(pipeline, id),
    );
    const usedCount = usedByModels.length + usedByPipelines.length;
    if (usedCount > 0) {
      return c.json(
        { error: `proxy target is used by ${usedCount} route(s)` },
        400,
      );
    }
    const deleted = deleteApiProxyTarget(id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });
}
