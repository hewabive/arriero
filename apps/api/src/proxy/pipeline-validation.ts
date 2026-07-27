import {
  apiProxyPipelineNodePorts,
  collectApiProxyPipelineExitNames,
  collectApiProxyRouteHoles,
  type ApiProxyPipelineNode,
  type ApiProxyPortRef,
  type ApiProxyRoutePipelineShape,
  type ApiProxyRouteTo,
} from "@arriero/core";

export type ApiProxyPipelineGraph = {
  id: string | null;
  name: string;
  entry: ApiProxyPortRef | null;
  nodes: ApiProxyPipelineNode[];
};

export type ApiProxyPipelineGraphContext = {
  getPipeline: (id: string) => ApiProxyPipelineGraph | null;
  hasTarget: (id: string) => boolean;
};

export function collectApiProxyPipelineRefs(graph: {
  entry: ApiProxyPortRef | null;
  nodes: ApiProxyPipelineNode[];
}): { pipelineIds: Set<string>; targetIds: Set<string> } {
  const pipelineIds = new Set<string>();
  const targetIds = new Set<string>();
  const addRef = (ref: ApiProxyPortRef | null) => {
    if (!ref) {
      return;
    }
    if (ref.type === "pipeline") {
      pipelineIds.add(ref.id);
    }
    if (ref.type === "target") {
      targetIds.add(ref.id);
    }
  };
  addRef(graph.entry);
  for (const node of graph.nodes) {
    for (const { ref } of apiProxyPipelineNodePorts(node)) {
      addRef(ref);
    }
    if (node.type === "call") {
      pipelineIds.add(node.config.pipelineId);
    }
  }
  return { pipelineIds, targetIds };
}

function nodeLabel(node: ApiProxyPipelineNode) {
  return node.name ? `${node.name} (${node.id})` : node.id;
}

export function validateApiProxyPipelineGraph(
  graph: ApiProxyPipelineGraph,
  context: ApiProxyPipelineGraphContext,
): string | null {
  const nodeById = new Map<string, ApiProxyPipelineNode>();
  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      return `duplicate node id "${node.id}"`;
    }
    nodeById.set(node.id, node);
  }

  const resolvePipeline = (id: string): ApiProxyPipelineGraph | null =>
    graph.id !== null && id === graph.id ? graph : context.getPipeline(id);

  const validateRef = (
    ref: ApiProxyPortRef | null,
    where: string,
  ): string | null => {
    if (!ref) {
      return null;
    }
    if (ref.type === "node" && !nodeById.has(ref.id)) {
      return `${where} references missing node "${ref.id}"`;
    }
    if (ref.type === "target" && !context.hasTarget(ref.id)) {
      return `${where} references missing target "${ref.id}"`;
    }
    if (ref.type === "pipeline" && !resolvePipeline(ref.id)) {
      return `${where} references missing pipeline "${ref.id}"`;
    }
    return null;
  };

  const entryError = validateRef(graph.entry, "entry");
  if (entryError) {
    return entryError;
  }
  for (const node of graph.nodes) {
    for (const { port, ref } of apiProxyPipelineNodePorts(node)) {
      const error = validateRef(ref, `node ${nodeLabel(node)} port "${port}"`);
      if (error) {
        return error;
      }
    }
  }

  const nodeCycleError = detectNodeCycle(graph, nodeById);
  if (nodeCycleError) {
    return nodeCycleError;
  }

  if (graph.id !== null) {
    const selfId = graph.id;
    const visited = new Set<string>();
    const queue = [...collectApiProxyPipelineRefs(graph).pipelineIds];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || visited.has(id)) {
        continue;
      }
      if (id === selfId) {
        return "pipeline references itself through a jump or call chain (loops are not allowed)";
      }
      visited.add(id);
      const pipeline = context.getPipeline(id);
      if (!pipeline) {
        continue;
      }
      queue.push(...collectApiProxyPipelineRefs(pipeline).pipelineIds);
    }
  }

  for (const node of graph.nodes) {
    if (node.type === "condition") {
      const predicate = node.config.predicate;
      if (predicate.type === "text-match" && predicate.regex) {
        try {
          new RegExp(predicate.pattern);
        } catch (error) {
          return `node ${nodeLabel(node)} has an invalid regex: ${(error as Error).message}`;
        }
      }
    }
    if (node.type === "call") {
      if (graph.id !== null && node.config.pipelineId === graph.id) {
        return `node ${nodeLabel(node)} calls its own pipeline`;
      }
      const callee = resolvePipeline(node.config.pipelineId);
      if (!callee) {
        return `node ${nodeLabel(node)} calls missing pipeline "${node.config.pipelineId}"`;
      }
      const exitNames = collectApiProxyPipelineExitNames(
        node.config.pipelineId,
        resolvePipeline,
      );
      for (const port of Object.keys(node.ports)) {
        if (!exitNames.has(port)) {
          return `node ${nodeLabel(node)} wires unknown exit "${port}" of pipeline ${callee.name}`;
        }
      }
    }
  }

  return null;
}

export type ApiProxyRouteModelBinding = {
  modelId: string;
  routeTo: ApiProxyRouteTo | null;
};

function describeRouteHoles(
  headPipelineId: string,
  getPipeline: (id: string) => ApiProxyRoutePipelineShape | null,
): string | null {
  const holes = collectApiProxyRouteHoles(headPipelineId, getPipeline);
  if (holes.length === 0) {
    return null;
  }
  return holes.map((hole) => hole.message).join("; ");
}

export function validateApiProxyModelRouteBinding(input: {
  routeTo: ApiProxyRouteTo | null | undefined;
  getPipeline: (id: string) => ApiProxyRoutePipelineShape | null;
}): string | null {
  if (input.routeTo?.type !== "pipeline") {
    return null;
  }
  const head = input.getPipeline(input.routeTo.id);
  if (!head) {
    return null;
  }
  const detail = describeRouteHoles(head.id, input.getPipeline);
  if (!detail) {
    return null;
  }
  return `pipeline "${head.name}" cannot serve a model until every path ends at a target: ${detail}`;
}

function routeClosureIncludes(
  headPipelineId: string,
  pipelineId: string,
  getPipeline: (id: string) => ApiProxyRoutePipelineShape | null,
): boolean {
  const visited = new Set<string>();
  const queue = [headPipelineId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (!id || visited.has(id)) {
      continue;
    }
    visited.add(id);
    if (id === pipelineId) {
      return true;
    }
    const pipeline = getPipeline(id);
    if (!pipeline) {
      continue;
    }
    queue.push(
      ...collectApiProxyPipelineRefs({
        entry: pipeline.entry,
        nodes: pipeline.nodes,
      }).pipelineIds,
    );
  }
  return false;
}

export function validateApiProxyPipelineRouteCompleteness(input: {
  candidate: ApiProxyRoutePipelineShape;
  models: ApiProxyRouteModelBinding[];
  getPipeline: (id: string) => ApiProxyRoutePipelineShape | null;
}): string | null {
  const resolve = (id: string) =>
    id === input.candidate.id ? input.candidate : input.getPipeline(id);
  const modelsByHead = new Map<string, string[]>();
  for (const model of input.models) {
    if (model.routeTo?.type !== "pipeline") {
      continue;
    }
    const list = modelsByHead.get(model.routeTo.id) ?? [];
    list.push(model.modelId);
    modelsByHead.set(model.routeTo.id, list);
  }
  for (const [headId, modelIds] of modelsByHead) {
    if (
      headId !== input.candidate.id &&
      !routeClosureIncludes(headId, input.candidate.id, resolve)
    ) {
      continue;
    }
    const detail = describeRouteHoles(headId, resolve);
    if (!detail) {
      continue;
    }
    const models = modelIds.map((id) => `"${id}"`).join(", ");
    if (headId === input.candidate.id) {
      return `pipeline serves model(s) ${models} and must route every path to a target: ${detail}`;
    }
    const head = resolve(headId);
    return `saving would break the route of model(s) ${models} through pipeline "${head?.name ?? headId}": ${detail}`;
  }
  return null;
}

export function collectApiProxyPipelineGraphWarnings(input: {
  pipelines: ApiProxyPipelineGraph[];
  hasTarget: (id: string) => boolean;
}): Array<{ pipeline: string; error: string }> {
  const context: ApiProxyPipelineGraphContext = {
    getPipeline: (id) =>
      input.pipelines.find((pipeline) => pipeline.id === id) ?? null,
    hasTarget: input.hasTarget,
  };
  const warnings: Array<{ pipeline: string; error: string }> = [];
  for (const pipeline of input.pipelines) {
    const error = validateApiProxyPipelineGraph(pipeline, context);
    if (error) {
      warnings.push({ pipeline: pipeline.name, error });
    }
  }
  return warnings;
}

function detectNodeCycle(
  graph: ApiProxyPipelineGraph,
  nodeById: Map<string, ApiProxyPipelineNode>,
): string | null {
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (nodeId: string): string | null => {
    if (done.has(nodeId)) {
      return null;
    }
    if (visiting.has(nodeId)) {
      return `nodes form a cycle through "${nodeId}" (loops are not allowed)`;
    }
    visiting.add(nodeId);
    const node = nodeById.get(nodeId);
    if (node) {
      for (const { ref } of apiProxyPipelineNodePorts(node)) {
        if (ref.type !== "node") {
          continue;
        }
        const error = visit(ref.id);
        if (error) {
          return error;
        }
      }
    }
    visiting.delete(nodeId);
    done.add(nodeId);
    return null;
  };

  for (const node of graph.nodes) {
    const error = visit(node.id);
    if (error) {
      return error;
    }
  }
  return null;
}
