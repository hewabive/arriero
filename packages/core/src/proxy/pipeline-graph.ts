import type { z } from "zod";
import type {
  ApiProxyPipelineNodeSchema,
  ApiProxyPortRefSchema,
} from "../index.js";

function legacyPipelinePortRef(
  routeTo: unknown,
): { type: "target" | "pipeline"; id: string } | null {
  if (!routeTo || typeof routeTo !== "object") {
    return null;
  }
  const { type, id } = routeTo as { type?: unknown; id?: unknown };
  if (
    (type === "target" || type === "pipeline") &&
    typeof id === "string" &&
    id
  ) {
    return { type, id };
  }
  return null;
}

export function upgradeLegacyApiProxyPipeline(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if ("nodes" in record || "entry" in record) {
    const { steps: _s, nodeType: _n, routeTo: _r, ...rest } = record;
    return rest;
  }
  if (!("steps" in record || "routeTo" in record || "nodeType" in record)) {
    return value;
  }
  const { steps, nodeType: _nodeType, routeTo, ...rest } = record;
  const terminal = legacyPipelinePortRef(routeTo);
  const legacySteps = (Array.isArray(steps) ? steps : []).flatMap(
    (step): Array<Record<string, unknown>> => {
      if (!step || typeof step !== "object") {
        return [];
      }
      const item = step as Record<string, unknown>;
      if (item.enabled === false) {
        return [];
      }
      if (item.type !== "replace-text" && item.type !== "capture-request") {
        return [];
      }
      return [item];
    },
  );
  const nodes = legacySteps.map((step, index) => ({
    id: typeof step.id === "string" && step.id ? step.id : `step-${index + 1}`,
    name: typeof step.name === "string" ? step.name : "",
    type: step.type,
    config: step.config ?? {},
    ports: { next: null as unknown },
  }));
  for (const [index, node] of nodes.entries()) {
    const following = nodes[index + 1];
    node.ports.next = following ? { type: "node", id: following.id } : terminal;
  }
  const first = nodes[0];
  return {
    ...rest,
    entry: first ? { type: "node", id: first.id } : terminal,
    nodes,
  };
}

export type ApiProxyPipelineGraphShape = {
  entry: z.infer<typeof ApiProxyPortRefSchema> | null;
  nodes: Array<z.infer<typeof ApiProxyPipelineNodeSchema>>;
};

export const apiProxySingleNextNodeTypes = [
  "replace-text",
  "capture-request",
  "edit-request",
  "reasoning",
  "output-limit",
  "token-scale",
  "strip-attribution",
  "cache",
] as const;

export type ApiProxySingleNextNodeType =
  (typeof apiProxySingleNextNodeTypes)[number];

const singleNextNodeTypeSet: ReadonlySet<string> = new Set(
  apiProxySingleNextNodeTypes,
);

export function isApiProxySingleNextNodeType(
  type: string,
): type is ApiProxySingleNextNodeType {
  return singleNextNodeTypeSet.has(type);
}

export function isApiProxySingleNextNode(
  node: z.infer<typeof ApiProxyPipelineNodeSchema>,
): node is Extract<
  z.infer<typeof ApiProxyPipelineNodeSchema>,
  { type: ApiProxySingleNextNodeType }
> {
  return isApiProxySingleNextNodeType(node.type);
}

export function apiProxyPipelineNodePorts(
  node: z.infer<typeof ApiProxyPipelineNodeSchema>,
): Array<{ port: string; ref: z.infer<typeof ApiProxyPortRefSchema> }> {
  if (isApiProxySingleNextNode(node)) {
    return node.ports.next ? [{ port: "next", ref: node.ports.next }] : [];
  }
  switch (node.type) {
    case "condition": {
      const refs: Array<{
        port: string;
        ref: z.infer<typeof ApiProxyPortRefSchema>;
      }> = [];
      if (node.ports.true) {
        refs.push({ port: "true", ref: node.ports.true });
      }
      if (node.ports.false) {
        refs.push({ port: "false", ref: node.ports.false });
      }
      return refs;
    }
    case "call":
      return Object.entries(node.ports).map(([port, ref]) => ({ port, ref }));
    case "exit":
      return [];
    case "fusion": {
      const refs: Array<{
        port: string;
        ref: z.infer<typeof ApiProxyPortRefSchema>;
      }> = [];
      node.ports.panel.forEach((ref, index) => {
        refs.push({ port: `panel-${index}`, ref });
      });
      if (node.ports.synthesizer) {
        refs.push({ port: "synthesizer", ref: node.ports.synthesizer });
      }
      return refs;
    }
  }
}

export function collectApiProxyPipelineExitNames(
  pipelineId: string,
  getPipeline: (id: string) => ApiProxyPipelineGraphShape | null,
): Set<string> {
  const visited = new Set<string>();
  const names = new Set<string>();
  const queue = [pipelineId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (!id || visited.has(id)) {
      continue;
    }
    visited.add(id);
    const pipeline = getPipeline(id);
    if (!pipeline) {
      continue;
    }
    for (const node of pipeline.nodes) {
      if (node.type === "exit") {
        names.add(node.config.exitName);
      }
    }
    if (pipeline.entry?.type === "pipeline") {
      queue.push(pipeline.entry.id);
    }
    for (const node of pipeline.nodes) {
      for (const { ref } of apiProxyPipelineNodePorts(node)) {
        if (ref.type === "pipeline") {
          queue.push(ref.id);
        }
      }
    }
  }
  return names;
}

export type ApiProxyRoutePipelineShape = ApiProxyPipelineGraphShape & {
  id: string;
  name: string;
};

export type ApiProxyRouteHole = {
  pipelineId: string | null;
  nodeId: string | null;
  message: string;
};

const routeHoleVisitBudget = 4096;

export function collectApiProxyRouteHoles(
  rootPipelineId: string,
  getPipeline: (id: string) => ApiProxyRoutePipelineShape | null,
): ApiProxyRouteHole[] {
  type PipelineNode = z.infer<typeof ApiProxyPipelineNodeSchema>;
  type PortRef = z.infer<typeof ApiProxyPortRefSchema>;
  type CallFrame = {
    pipeline: ApiProxyRoutePipelineShape;
    node: Extract<PipelineNode, { type: "call" }>;
  };

  const holes = new Map<string, ApiProxyRouteHole>();
  const visited = new Set<string>();
  let budget = routeHoleVisitBudget;

  const addHole = (
    pipelineId: string | null,
    nodeId: string | null,
    message: string,
  ) => {
    holes.set(`${pipelineId}|${nodeId}|${message}`, {
      pipelineId,
      nodeId,
      message,
    });
  };

  const label = (node: PipelineNode) =>
    node.name ? `${node.name} (${node.id})` : node.id;

  const stackKey = (stack: CallFrame[]) =>
    stack.map((frame) => `${frame.pipeline.id}/${frame.node.id}`).join(",");

  const visitNode = (
    node: PipelineNode,
    pipeline: ApiProxyRoutePipelineShape,
    stack: CallFrame[],
  ): void => {
    if (isApiProxySingleNextNode(node)) {
      visit(node.ports.next, pipeline, stack, {
        nodeId: node.id,
        where: `port "next" of node ${label(node)}`,
      });
      return;
    }
    switch (node.type) {
      case "condition":
        visit(node.ports.true, pipeline, stack, {
          nodeId: node.id,
          where: `port "true" of node ${label(node)}`,
        });
        visit(node.ports.false, pipeline, stack, {
          nodeId: node.id,
          where: `port "false" of node ${label(node)}`,
        });
        return;
      case "call": {
        const callee = getPipeline(node.config.pipelineId);
        if (!callee) {
          addHole(
            pipeline.id,
            node.id,
            `call node ${label(node)} in pipeline "${pipeline.name}" calls missing pipeline "${node.config.pipelineId}"`,
          );
          return;
        }
        visit(callee.entry, callee, [...stack, { pipeline, node }], {
          nodeId: null,
          where: "entry",
        });
        return;
      }
      case "exit": {
        const exitName = node.config.exitName;
        const frame = stack[stack.length - 1];
        if (!frame) {
          addHole(
            pipeline.id,
            node.id,
            `exit "${exitName}" in pipeline "${pipeline.name}" escapes the route (reached without a call) — wire it from a call node or end at a target`,
          );
          return;
        }
        const continuation = frame.node.ports[exitName];
        if (!continuation) {
          addHole(
            frame.pipeline.id,
            frame.node.id,
            `call node ${label(frame.node)} in pipeline "${frame.pipeline.name}" has no wiring for exit "${exitName}"`,
          );
          return;
        }
        visit(continuation, frame.pipeline, stack.slice(0, -1), {
          nodeId: frame.node.id,
          where: `exit "${exitName}" of call node ${label(frame.node)}`,
        });
        return;
      }
      case "fusion":
        return;
    }
  };

  const visit = (
    ref: PortRef | null,
    pipeline: ApiProxyRoutePipelineShape,
    stack: CallFrame[],
    holeAt: { nodeId: string | null; where: string },
  ): void => {
    if (budget <= 0) {
      return;
    }
    budget -= 1;
    if (!ref) {
      addHole(
        pipeline.id,
        holeAt.nodeId,
        `${holeAt.where} in pipeline "${pipeline.name}" is unwired`,
      );
      return;
    }
    const key = `${ref.type}:${ref.id}@${pipeline.id}#${stackKey(stack)}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    if (ref.type === "target") {
      return;
    }
    if (ref.type === "pipeline") {
      const next = getPipeline(ref.id);
      if (!next) {
        addHole(
          pipeline.id,
          holeAt.nodeId,
          `${holeAt.where} in pipeline "${pipeline.name}" references missing pipeline "${ref.id}"`,
        );
        return;
      }
      visit(next.entry, next, stack, { nodeId: null, where: "entry" });
      return;
    }
    const nodeId = ref.id;
    const node = pipeline.nodes.find((item) => item.id === nodeId);
    if (!node) {
      addHole(
        pipeline.id,
        holeAt.nodeId,
        `${holeAt.where} in pipeline "${pipeline.name}" references missing node "${nodeId}"`,
      );
      return;
    }
    visitNode(node, pipeline, stack);
  };

  const root = getPipeline(rootPipelineId);
  if (!root) {
    addHole(null, null, `route pipeline "${rootPipelineId}" not found`);
    return [...holes.values()];
  }
  visit(root.entry, root, [], { nodeId: null, where: "entry" });
  return [...holes.values()];
}
