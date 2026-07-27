import {
  apiProxyInflightPhaseEnded,
  type ApiProxyInflightRequest,
  type ApiProxyModelRecord,
  type ApiProxyModelState,
  type ApiProxyPipelineRecord,
  type ApiProxyPublicModelLoadState,
  type ApiProxyPublicModelStatus,
  type ApiProxyRuntimeSnapshot,
} from "@arriero/core";

import { apiProxyInflight } from "./inflight.js";
import { collectApiProxyPipelineRefs } from "./pipeline-validation.js";
import { listApiProxyModels, listApiProxyPipelines } from "./repository.js";
import { getCachedApiProxyRuntimeSnapshot } from "./runtime-snapshot.js";

type LeafLoadState = "unloaded" | "loading" | "loaded" | "failed";

function leafLoadFromTargetState(state: ApiProxyModelState): LeafLoadState {
  switch (state) {
    case "ready":
      return "loaded";
    case "loading":
      return "loading";
    case "error":
      return "failed";
    default:
      return "unloaded";
  }
}

function collectPipelineTargetLeaves(
  headId: string,
  pipelinesById: Map<string, ApiProxyPipelineRecord>,
): string[] {
  const targets = new Set<string>();
  const visited = new Set<string>();
  const queue = [headId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (!id || visited.has(id)) {
      continue;
    }
    visited.add(id);
    const pipeline = pipelinesById.get(id);
    if (!pipeline) {
      continue;
    }
    const refs = collectApiProxyPipelineRefs({
      entry: pipeline.entry,
      nodes: pipeline.nodes,
    });
    for (const targetId of refs.targetIds) {
      targets.add(targetId);
    }
    for (const pipelineId of refs.pipelineIds) {
      queue.push(pipelineId);
    }
  }
  return [...targets];
}

export function resolveApiProxyModelLeafTargetIds(
  model: Pick<ApiProxyModelRecord, "routeTo" | "targetId">,
  pipelinesById: Map<string, ApiProxyPipelineRecord>,
): string[] {
  if (model.routeTo?.type === "target") {
    return [model.routeTo.id];
  }
  if (model.routeTo?.type === "pipeline") {
    return collectPipelineTargetLeaves(model.routeTo.id, pipelinesById);
  }
  if (model.targetId) {
    return [model.targetId];
  }
  return [];
}

export function aggregateApiProxyLoadState(
  leaves: LeafLoadState[],
): ApiProxyPublicModelLoadState {
  if (leaves.length === 0) {
    return "unloaded";
  }
  const loaded = leaves.filter((leaf) => leaf === "loaded").length;
  if (loaded === leaves.length) {
    return "loaded";
  }
  if (loaded > 0) {
    return "partial";
  }
  if (leaves.some((leaf) => leaf === "loading")) {
    return "loading";
  }
  if (leaves.some((leaf) => leaf === "failed")) {
    return "failed";
  }
  return "unloaded";
}

export function deriveApiProxyModelStatus(input: {
  model: ApiProxyModelRecord;
  snapshot: ApiProxyRuntimeSnapshot;
  pipelinesById: Map<string, ApiProxyPipelineRecord>;
  inflight: ApiProxyInflightRequest[];
}): ApiProxyPublicModelStatus {
  const activeRequests = input.inflight.filter(
    (request) =>
      request.phase !== "queued" && !apiProxyInflightPhaseEnded(request.phase),
  ).length;
  const queuedRequests = input.inflight.filter(
    (request) => request.phase === "queued",
  ).length;

  if (!input.model.enabled) {
    return { value: "disabled", activeRequests, queuedRequests };
  }

  if (input.model.routeTo?.type === "endpoint") {
    return { value: "loaded", activeRequests, queuedRequests };
  }

  const stateByTargetId = new Map(
    input.snapshot.targets.map((target) => [target.targetId, target.state]),
  );
  const leaves = resolveApiProxyModelLeafTargetIds(
    input.model,
    input.pipelinesById,
  ).map((targetId) =>
    leafLoadFromTargetState(stateByTargetId.get(targetId) ?? "unloaded"),
  );

  return {
    value: aggregateApiProxyLoadState(leaves),
    activeRequests,
    queuedRequests,
  };
}

export async function getApiProxyPublicModelStatuses(
  models: ApiProxyModelRecord[] = listApiProxyModels(),
): Promise<Map<string, ApiProxyPublicModelStatus>> {
  const pipelinesById = new Map(
    listApiProxyPipelines().map((pipeline) => [pipeline.id, pipeline]),
  );
  const { snapshot } = await getCachedApiProxyRuntimeSnapshot();
  const inflightByModel = apiProxyInflight.snapshotByModel();

  const statuses = new Map<string, ApiProxyPublicModelStatus>();
  for (const model of models) {
    statuses.set(
      model.modelId,
      deriveApiProxyModelStatus({
        model,
        snapshot,
        pipelinesById,
        inflight: inflightByModel.get(model.modelId) ?? [],
      }),
    );
  }
  return statuses;
}
