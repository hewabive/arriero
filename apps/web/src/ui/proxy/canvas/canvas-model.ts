import {
  activeApiProxyTextReplacementRules,
  apiProxyPipelineNodePorts,
  apiProxyReasoningEffortBudgets,
  isApiProxySingleNextNodeType,
  type ApiProxyModelRecord,
  type ApiProxyPipelineRecord,
  type ApiProxyRouteTraceStep,
  type ApiProxySourceRecord,
  type ApiProxyTargetRecord,
} from "@arriero/core";
import type { Edge, Node } from "@xyflow/react";

import type { PipelineDraft, PipelineNodeDraft, PortValue } from "../forms";
import { countLabel } from "../../utils/plural";

export type FlowNodeKind =
  | PipelineNodeDraft["type"]
  | "entry"
  | "ref-target"
  | "ref-pipeline"
  | "ref-model";

export type FlowNodeData = {
  kind: FlowNodeKind;
  title: string;
  summary: string;
  sourcePorts: string[];
  hasInput: boolean;
  highlighted: boolean;
  invalid: boolean;
  [key: string]: unknown;
};

export type FlowNode = Node<FlowNodeData>;

export const entryNodeId = "__entry__";
export const entryPortName = "start";
export const referrerFlowPrefix = "in:";
export const referrerPipelineFlowPrefix = "in:pipeline:";
export const referrerPortName = "out";

export type PipelineReferrer = {
  flowId: string;
  kind: "ref-model" | "ref-pipeline";
  title: string;
  summary: string;
};

export function collectPipelineReferrers(input: {
  pipelineId: string | null;
  models: ApiProxyModelRecord[];
  pipelines: ApiProxyPipelineRecord[];
  bindModelIds: string[];
  unbindModelIds: string[];
}): PipelineReferrer[] {
  const referrers: PipelineReferrer[] = [];
  const staged = new Set(input.bindModelIds);
  for (const model of input.models) {
    const bound =
      input.pipelineId !== null &&
      model.routeTo?.type === "pipeline" &&
      model.routeTo.id === input.pipelineId &&
      !input.unbindModelIds.includes(model.id);
    if (!bound && !staged.has(model.id)) {
      continue;
    }
    referrers.push({
      flowId: `in:model:${model.id}`,
      kind: "ref-model",
      title: model.modelId,
      summary: staged.has(model.id) ? "model · unsaved" : "model",
    });
  }
  if (input.pipelineId === null) {
    return referrers;
  }
  for (const pipeline of input.pipelines) {
    if (pipeline.id === input.pipelineId) {
      continue;
    }
    const calls = pipeline.nodes.some(
      (node) =>
        node.type === "call" && node.config.pipelineId === input.pipelineId,
    );
    const jumpRefs = [
      ...(pipeline.entry ? [pipeline.entry] : []),
      ...pipeline.nodes.flatMap((node) =>
        apiProxyPipelineNodePorts(node).map((port) => port.ref),
      ),
    ];
    const jumps = jumpRefs.some(
      (ref) => ref.type === "pipeline" && ref.id === input.pipelineId,
    );
    if (!calls && !jumps) {
      continue;
    }
    referrers.push({
      flowId: `${referrerPipelineFlowPrefix}${pipeline.id}`,
      kind: "ref-pipeline",
      title: pipeline.name,
      summary: calls && jumps ? "call · jump" : calls ? "call" : "jump",
    });
  }
  return referrers;
}

export function refNodeId(value: string) {
  return `ref:${value}`;
}

export function portValueFromFlowId(flowId: string): PortValue {
  return flowId.startsWith("ref:") ? flowId.slice(4) : `node:${flowId}`;
}

export function flowIdFromPortValue(value: string): string {
  return value.startsWith("node:") ? value.slice(5) : refNodeId(value);
}

export type FlowHighlight = {
  nodes: Set<string>;
  ports: Set<string>;
};

export function highlightFromTrace(
  trace: ApiProxyRouteTraceStep[] | null,
  pipelineId: string | null,
): FlowHighlight | null {
  if (!trace || !pipelineId) {
    return null;
  }
  const nodes = new Set<string>();
  const ports = new Set<string>();
  let entered = false;
  const callStack: Array<{ nodeId: string; pipelineId: string | null }> = [];
  for (const step of trace) {
    if (step.kind === "call" && step.nodeId) {
      callStack.push({ nodeId: step.nodeId, pipelineId: step.pipelineId });
    }
    if (step.kind === "exit") {
      const frame = callStack.pop();
      if (frame && frame.pipelineId === pipelineId && step.port) {
        ports.add(`${frame.nodeId}:${step.port}`);
      }
    }
    if (step.pipelineId !== pipelineId) {
      continue;
    }
    if (step.kind === "enter-pipeline") {
      entered = true;
      continue;
    }
    if (step.nodeId) {
      nodes.add(step.nodeId);
      if (step.port) {
        ports.add(`${step.nodeId}:${step.port}`);
      }
    }
  }
  if (!entered && nodes.size === 0) {
    return null;
  }
  if (entered) {
    nodes.add(entryNodeId);
    ports.add(`${entryNodeId}:${entryPortName}`);
  }
  return { nodes, ports };
}

export function draftNodePorts(
  node: PipelineNodeDraft,
  exitNames: string[],
): Array<{ port: string; value: PortValue }> {
  if (isApiProxySingleNextNodeType(node.type)) {
    return [{ port: "next", value: node.portNext }];
  }
  switch (node.type) {
    case "condition":
      return [
        { port: "true", value: node.portTrue },
        { port: "false", value: node.portFalse },
      ];
    case "call":
      return exitNames.map((name) => ({
        port: name,
        value: node.callPorts[name] ?? null,
      }));
    case "exit":
      return [];
    case "fusion":
      return [
        ...node.fusionPanel.map((value, index) => ({
          port: `panel-${index}`,
          value,
        })),
        { port: "synthesizer", value: node.fusionSynthesizer },
      ];
  }
}

export function nodeSummary(
  node: PipelineNodeDraft,
  context: {
    pipelines: ApiProxyPipelineRecord[];
    sources: ApiProxySourceRecord[];
  },
): string {
  switch (node.type) {
    case "replace-text": {
      const count = activeApiProxyTextReplacementRules(
        node.replacements,
      ).length;
      const surfaces = [
        node.replaceRequest ? "request" : null,
        node.replaceResponse ? "response" : null,
      ].filter((surface): surface is string => surface !== null);
      const suffix = surfaces.length > 0 ? ` · ${surfaces.join(" + ")}` : "";
      return `${countLabel(count, "rule")}${suffix}`;
    }
    case "capture-request": {
      const saves = [
        node.captureRequest ? "request" : null,
        node.captureResponse ? "response" : null,
      ].filter((part): part is string => part !== null);
      return saves.length > 0 ? `saves ${saves.join(" + ")}` : "saves nothing";
    }
    case "edit-request": {
      const count = node.editOperations.filter(
        (operation) => operation.enabled,
      ).length;
      return countLabel(count, "operation");
    }
    case "reasoning":
      return reasoningSummary(node);
    case "output-limit":
      return `${node.outputLimitMode} max_tokens ${node.outputLimitMax || "?"}`;
    case "context-limit":
      return `reject ≥ ${node.contextLimitThreshold || "?"} tokens (est.)`;
    case "token-scale":
      return `visible / real ×${node.tokenScaleFactor || "?"}`;
    case "strip-attribution":
      return "strip Claude Code attribution";
    case "cache": {
      const ttl = node.cacheTtlSeconds === "" ? 0 : node.cacheTtlSeconds;
      const ns = node.cacheNamespace ? `${node.cacheNamespace} · ` : "";
      return `${ns}${ttl > 0 ? `ttl ${ttl}s` : "no expiry"}`;
    }
    case "condition": {
      if (node.predicateType === "token-estimate") {
        return `≥ ${node.minTokens || "?"} tokens (est.)`;
      }
      if (node.predicateType === "source") {
        const source = context.sources.find(
          (item) => item.id === node.sourceId,
        );
        return `source = ${source?.name ?? (node.sourceId || "anonymous")}`;
      }
      const pattern = node.regex ? `/${node.pattern}/` : `"${node.pattern}"`;
      return `${pattern} in ${node.scope}`;
    }
    case "call": {
      const callee = context.pipelines.find(
        (pipeline) => pipeline.id === node.callPipelineId,
      );
      return callee?.name ?? "select a pipeline";
    }
    case "exit":
      return `exit "${node.exitName || "done"}"`;
    case "fusion": {
      const wired = node.fusionPanel.filter((value) => value !== null).length;
      return `fusion: ${wired} panel → synthesizer`;
    }
  }
}

function reasoningSummary(node: PipelineNodeDraft): string {
  if (node.reasoningEffort === "off") {
    return "thinking off";
  }
  const budget =
    node.reasoningEffort === "custom"
      ? node.reasoningCustomBudget === ""
        ? -1
        : Number(node.reasoningCustomBudget)
      : apiProxyReasoningEffortBudgets[node.reasoningEffort];
  const budgetLabel = budget < 0 ? "unlimited" : `${budget} tok`;
  return `${node.reasoningEffort} · ${budgetLabel}`;
}

type BuildInput = {
  draft: PipelineDraft;
  targets: ApiProxyTargetRecord[];
  pipelines: ApiProxyPipelineRecord[];
  sources: ApiProxySourceRecord[];
  exitNamesByNodeId: Map<string, string[]>;
  highlight: FlowHighlight | null;
  previousPositions: Map<string, { x: number; y: number }>;
  selectedNodeId: string | null;
  referrers: PipelineReferrer[];
  entryInvalid: boolean;
  invalidNodeIds: Set<string>;
  placedRefs: string[];
};

export const columnWidth = 300;
const rowHeight = 170;
const originX = 220;
const originY = 60;

function autoLayout(input: BuildInput): Map<string, { x: number; y: number }> {
  const depths = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [];
  if (input.draft.entryValue?.startsWith("node:")) {
    queue.push({ id: input.draft.entryValue.slice(5), depth: 0 });
  }
  const nodeById = new Map(
    input.draft.nodes.map((node) => [node.id, node] as const),
  );
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    const existing = depths.get(item.id);
    if (existing !== undefined && existing >= item.depth) {
      continue;
    }
    if (item.depth > input.draft.nodes.length) {
      continue;
    }
    depths.set(item.id, item.depth);
    const node = nodeById.get(item.id);
    if (!node) {
      continue;
    }
    const exitNames = input.exitNamesByNodeId.get(node.id) ?? [];
    for (const { value } of draftNodePorts(node, exitNames)) {
      if (value?.startsWith("node:")) {
        queue.push({ id: value.slice(5), depth: item.depth + 1 });
      }
    }
  }
  let orphanDepth = 0;
  for (const node of input.draft.nodes) {
    if (!depths.has(node.id)) {
      depths.set(node.id, orphanDepth);
      orphanDepth += 1;
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  const laneByDepth = new Map<number, number>();
  for (const node of input.draft.nodes) {
    const depth = depths.get(node.id) ?? 0;
    const lane = laneByDepth.get(depth) ?? 0;
    laneByDepth.set(depth, lane + 1);
    positions.set(node.id, {
      x: originX + depth * columnWidth,
      y: originY + lane * rowHeight,
    });
  }
  return positions;
}

export function buildFlowGraph(input: BuildInput): {
  nodes: FlowNode[];
  edges: Edge[];
} {
  const auto = autoLayout(input);
  const highlight = input.highlight;
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  const refTitles = new Map<string, { kind: FlowNodeKind; title: string }>();

  const resolvePosition = (id: string, fallback: { x: number; y: number }) =>
    input.previousPositions.get(id) ?? fallback;

  const ensureRefNode = (value: string, fallback: { x: number; y: number }) => {
    const flowId = flowIdFromPortValue(value);
    if (refTitles.has(flowId)) {
      return flowId;
    }
    const [refKind, refId] = value.startsWith("target:")
      ? (["ref-target", value.slice(7)] as const)
      : (["ref-pipeline", value.slice(9)] as const);
    const title =
      refKind === "ref-target"
        ? (input.targets.find((target) => target.id === refId)?.name ?? refId)
        : (input.pipelines.find((pipeline) => pipeline.id === refId)?.name ??
          refId);
    refTitles.set(flowId, { kind: refKind, title });
    nodes.push({
      id: flowId,
      type: "pipeline-flow",
      position: resolvePosition(flowId, fallback),
      selected: flowId === input.selectedNodeId,
      data: {
        kind: refKind,
        title,
        summary: refKind === "ref-target" ? "target" : "pipeline",
        sourcePorts: [],
        hasInput: true,
        highlighted: false,
        invalid: false,
      },
    });
    return flowId;
  };

  const pushEdge = (
    sourceId: string,
    port: string,
    value: PortValue,
    sourceNodeDepthPosition: { x: number; y: number },
  ) => {
    if (!value) {
      return;
    }
    const targetFlowId = value.startsWith("node:")
      ? flowIdFromPortValue(value)
      : ensureRefNode(value, {
          x: sourceNodeDepthPosition.x + columnWidth,
          y: sourceNodeDepthPosition.y + refTitles.size * 110,
        });
    const highlighted = highlight?.ports.has(`${sourceId}:${port}`) ?? false;
    edges.push({
      id: `e:${sourceId}:${port}`,
      type: "pipeline-edge",
      source: sourceId,
      sourceHandle: port,
      target: targetFlowId,
      animated: highlighted,
      ...(highlighted
        ? {
            style: {
              stroke: "var(--mantine-color-teal-5)",
              strokeWidth: 2,
            },
          }
        : {}),
    });
  };

  const entryPosition = resolvePosition(entryNodeId, {
    x: originX - columnWidth,
    y: originY,
  });
  nodes.push({
    id: entryNodeId,
    type: "pipeline-flow",
    position: entryPosition,
    deletable: false,
    selected: input.selectedNodeId === entryNodeId,
    data: {
      kind: "entry",
      title: "entry",
      summary: "",
      sourcePorts: [entryPortName],
      hasInput: input.referrers.length > 0,
      highlighted: highlight?.nodes.has(entryNodeId) ?? false,
      invalid: input.entryInvalid,
    },
  });

  input.referrers.forEach((referrer, index) => {
    nodes.push({
      id: referrer.flowId,
      type: "pipeline-flow",
      position: resolvePosition(referrer.flowId, {
        x: entryPosition.x - columnWidth,
        y: entryPosition.y + index * 110,
      }),
      deletable: false,
      data: {
        kind: referrer.kind,
        title: referrer.title,
        summary: referrer.summary,
        sourcePorts: [referrerPortName],
        hasInput: false,
        highlighted: false,
        invalid: false,
      },
    });
    edges.push({
      id: `e:${referrer.flowId}`,
      type: "pipeline-edge",
      source: referrer.flowId,
      sourceHandle: referrerPortName,
      target: entryNodeId,
      deletable: false,
      selectable: false,
    });
  });

  input.placedRefs.forEach((value, index) => {
    if (!value.startsWith("node:")) {
      ensureRefNode(value, {
        x: originX + 2 * columnWidth,
        y: originY + index * 110,
      });
    }
  });

  for (const node of input.draft.nodes) {
    const position = resolvePosition(
      node.id,
      node.layout ?? auto.get(node.id) ?? { x: originX, y: originY },
    );
    nodes.push({
      id: node.id,
      type: "pipeline-flow",
      position,
      selected: node.id === input.selectedNodeId,
      data: {
        kind: node.type,
        title: node.name || node.id,
        summary: nodeSummary(node, input),
        sourcePorts: draftNodePorts(
          node,
          input.exitNamesByNodeId.get(node.id) ?? [],
        ).map((item) => item.port),
        hasInput: true,
        highlighted: highlight?.nodes.has(node.id) ?? false,
        invalid: input.invalidNodeIds.has(node.id),
      },
    });
  }

  if (input.draft.entryValue) {
    pushEdge(entryNodeId, entryPortName, input.draft.entryValue, entryPosition);
  }
  for (const node of input.draft.nodes) {
    const exitNames = input.exitNamesByNodeId.get(node.id) ?? [];
    const position = input.previousPositions.get(node.id) ??
      node.layout ??
      auto.get(node.id) ?? { x: originX, y: originY };
    for (const { port, value } of draftNodePorts(node, exitNames)) {
      pushEdge(node.id, port, value, position);
    }
  }

  return { nodes, edges };
}
