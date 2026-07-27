import {
  apiProxyPipelineNodePorts,
  type ApiProxyModelRecord,
  type ApiProxyPipelineNode,
  type ApiProxyPipelineRecord,
  type ApiProxyPortRef,
} from "@arriero/core";

import { modelDirectTargetId } from "./forms";

export type ProxyUsageRef = {
  kind: "model" | "pipeline";
  id: string;
  label: string;
  enabled: boolean;
  via: string[];
};

export type ProxyUsageIndex = {
  byTargetId: Map<string, ProxyUsageRef[]>;
  byPipelineId: Map<string, ProxyUsageRef[]>;
};

function addUsageRef(
  map: Map<string, ProxyUsageRef[]>,
  key: string,
  ref: Omit<ProxyUsageRef, "via">,
  via: string | null,
) {
  let refs = map.get(key);
  if (!refs) {
    refs = [];
    map.set(key, refs);
  }
  const existing = refs.find(
    (item) => item.kind === ref.kind && item.id === ref.id,
  );
  if (existing) {
    if (via && !existing.via.includes(via)) {
      existing.via.push(via);
    }
    return;
  }
  refs.push({ ...ref, via: via ? [via] : [] });
}

function nodeVia(node: ApiProxyPipelineNode, port: string | null): string {
  const name = node.name || node.type;
  return port && port !== "next" ? `${name} → ${port}` : name;
}

function pipelineOutgoingRefs(
  pipeline: ApiProxyPipelineRecord,
): Array<{ ref: ApiProxyPortRef; via: string }> {
  const refs: Array<{ ref: ApiProxyPortRef; via: string }> = [];
  if (pipeline.entry && pipeline.entry.type !== "node") {
    refs.push({ ref: pipeline.entry, via: "entry" });
  }
  for (const node of pipeline.nodes) {
    if (node.type === "call") {
      refs.push({
        ref: { type: "pipeline", id: node.config.pipelineId },
        via: nodeVia(node, null),
      });
    }
    for (const port of apiProxyPipelineNodePorts(node)) {
      if (port.ref.type !== "node") {
        refs.push({ ref: port.ref, via: nodeVia(node, port.port) });
      }
    }
  }
  return refs;
}

export function computeProxyUsage(
  models: ApiProxyModelRecord[],
  pipelines: ApiProxyPipelineRecord[],
): ProxyUsageIndex {
  const byTargetId = new Map<string, ProxyUsageRef[]>();
  const byPipelineId = new Map<string, ProxyUsageRef[]>();

  for (const model of models) {
    const modelRef = {
      kind: "model" as const,
      id: model.id,
      label: model.modelId,
      enabled: model.enabled,
    };
    const targetId = modelDirectTargetId(model);
    if (targetId) {
      addUsageRef(byTargetId, targetId, modelRef, null);
    } else if (model.routeTo?.type === "pipeline") {
      addUsageRef(byPipelineId, model.routeTo.id, modelRef, null);
    }
  }

  for (const pipeline of pipelines) {
    const pipelineRef = {
      kind: "pipeline" as const,
      id: pipeline.id,
      label: pipeline.name,
      enabled: pipeline.enabled,
    };
    for (const outgoing of pipelineOutgoingRefs(pipeline)) {
      if (outgoing.ref.id === pipeline.id) {
        continue;
      }
      const map = outgoing.ref.type === "target" ? byTargetId : byPipelineId;
      addUsageRef(map, outgoing.ref.id, pipelineRef, outgoing.via);
    }
  }

  return { byTargetId, byPipelineId };
}
