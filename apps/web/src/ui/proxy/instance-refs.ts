import type {
  ApiProxyModelRecord,
  ApiProxyPipelineRecord,
  ApiProxyPortRef,
  ApiProxyTargetRecord,
} from "@arriero/core";

import { modelDirectTargetId } from "./forms";
import {
  computeProxyUsage,
  pipelineOutgoingRefs,
  type ProxyUsageRef,
} from "./usage";

export type InstanceProxyConfig = {
  targets: ApiProxyTargetRecord[];
  models: ApiProxyModelRecord[];
  pipelines: ApiProxyPipelineRecord[];
};

export type InstanceProxyRefs = {
  referencingTargets: ApiProxyTargetRecord[];
  boundModels: ApiProxyModelRecord[];
  deletableTargets: ApiProxyTargetRecord[];
  deletableModels: ApiProxyModelRecord[];
  deletablePipelines: ApiProxyPipelineRecord[];
  keptTargets: Array<{ target: ApiProxyTargetRecord; keptBy: string[] }>;
  keptPipelines: Array<{ pipeline: ApiProxyPipelineRecord; keptBy: string[] }>;
  brokenPipelines: ApiProxyPipelineRecord[];
};

function deadPipelineIdsFor(
  pipelines: ApiProxyPipelineRecord[],
  outgoing: Map<string, ApiProxyPortRef[]>,
  deadTargetIds: Set<string>,
): Set<string> {
  const dead = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pipeline of pipelines) {
      if (dead.has(pipeline.id)) {
        continue;
      }
      const refs = outgoing.get(pipeline.id) ?? [];
      if (refs.length === 0) {
        continue;
      }
      const allDead = refs.every((ref) =>
        ref.type === "target"
          ? deadTargetIds.has(ref.id)
          : ref.type === "pipeline"
            ? dead.has(ref.id)
            : false,
      );
      if (allDead) {
        dead.add(pipeline.id);
        changed = true;
      }
    }
  }
  return dead;
}

function boundModelsFor(
  instanceEndpointId: string,
  config: InstanceProxyConfig,
  referencingTargetIds: Set<string>,
): ApiProxyModelRecord[] {
  const usage = computeProxyUsage(config.models, config.pipelines);
  const boundModelIds = new Set<string>();
  const pipelineQueue: string[] = [];
  const seenPipelines = new Set<string>();
  const enqueueRefs = (refs: ProxyUsageRef[] | undefined) => {
    for (const ref of refs ?? []) {
      if (ref.kind === "model") {
        boundModelIds.add(ref.id);
      } else if (!seenPipelines.has(ref.id)) {
        seenPipelines.add(ref.id);
        pipelineQueue.push(ref.id);
      }
    }
  };
  for (const targetId of referencingTargetIds) {
    enqueueRefs(usage.byTargetId.get(targetId));
  }
  while (pipelineQueue.length > 0) {
    enqueueRefs(usage.byPipelineId.get(pipelineQueue.pop()!));
  }
  return config.models.filter(
    (model) =>
      boundModelIds.has(model.id) ||
      (model.routeTo?.type === "endpoint" &&
        model.routeTo.endpointId === instanceEndpointId),
  );
}

function pipelineDeleteOrder(
  deletable: ApiProxyPipelineRecord[],
  outgoing: Map<string, ApiProxyPortRef[]>,
): ApiProxyPipelineRecord[] {
  const remaining = new Map(
    deletable.map((pipeline) => [pipeline.id, pipeline]),
  );
  const ordered: ApiProxyPipelineRecord[] = [];
  while (remaining.size > 0) {
    const referenced = new Set<string>();
    for (const id of remaining.keys()) {
      for (const ref of outgoing.get(id) ?? []) {
        if (ref.type === "pipeline" && ref.id !== id && remaining.has(ref.id)) {
          referenced.add(ref.id);
        }
      }
    }
    const roots = [...remaining.values()].filter(
      (pipeline) => !referenced.has(pipeline.id),
    );
    if (roots.length === 0) {
      ordered.push(...remaining.values());
      break;
    }
    for (const pipeline of roots) {
      ordered.push(pipeline);
      remaining.delete(pipeline.id);
    }
  }
  return ordered;
}

export function computeInstanceProxyRefs(
  instanceName: string,
  config: InstanceProxyConfig,
): InstanceProxyRefs {
  const endpointId = `instance:${instanceName}`;
  const referencingTargets = config.targets.filter(
    (target) => target.endpointId === endpointId,
  );
  const deadTargetIds = new Set(referencingTargets.map((target) => target.id));
  const boundModels = boundModelsFor(endpointId, config, deadTargetIds);

  const outgoing = new Map(
    config.pipelines.map((pipeline) => [
      pipeline.id,
      pipelineOutgoingRefs(pipeline).map((item) => item.ref),
    ]),
  );
  const deadPipelineIds = deadPipelineIdsFor(
    config.pipelines,
    outgoing,
    deadTargetIds,
  );

  const deletableModels = config.models.filter((model) => {
    if (model.routeTo?.type === "endpoint") {
      return model.routeTo.endpointId === endpointId;
    }
    if (model.routeTo?.type === "pipeline") {
      return deadPipelineIds.has(model.routeTo.id);
    }
    const targetId = modelDirectTargetId(model);
    return targetId !== null && deadTargetIds.has(targetId);
  });

  const brokenPipelines = config.pipelines.filter(
    (pipeline) =>
      !deadPipelineIds.has(pipeline.id) &&
      (outgoing.get(pipeline.id) ?? []).some(
        (ref) =>
          (ref.type === "target" && deadTargetIds.has(ref.id)) ||
          (ref.type === "pipeline" && deadPipelineIds.has(ref.id)),
      ),
  );

  const keptTargetIds = new Map<string, string[]>();
  const keptPipelineIds = new Map<string, string[]>();
  for (const pipeline of brokenPipelines) {
    for (const ref of outgoing.get(pipeline.id) ?? []) {
      if (ref.type === "target" && deadTargetIds.has(ref.id)) {
        keptTargetIds.set(ref.id, [
          ...(keptTargetIds.get(ref.id) ?? []),
          pipeline.name,
        ]);
      }
      if (ref.type === "pipeline" && deadPipelineIds.has(ref.id)) {
        keptPipelineIds.set(ref.id, [
          ...(keptPipelineIds.get(ref.id) ?? []),
          pipeline.name,
        ]);
      }
    }
  }

  const deletableTargets = referencingTargets.filter(
    (target) => !keptTargetIds.has(target.id),
  );
  const keptTargets = referencingTargets
    .filter((target) => keptTargetIds.has(target.id))
    .map((target) => ({ target, keptBy: keptTargetIds.get(target.id)! }));

  const deadPipelines = config.pipelines.filter((pipeline) =>
    deadPipelineIds.has(pipeline.id),
  );
  const deletablePipelines = pipelineDeleteOrder(
    deadPipelines.filter((pipeline) => !keptPipelineIds.has(pipeline.id)),
    outgoing,
  );
  const keptPipelines = deadPipelines
    .filter((pipeline) => keptPipelineIds.has(pipeline.id))
    .map((pipeline) => ({
      pipeline,
      keptBy: keptPipelineIds.get(pipeline.id)!,
    }));

  return {
    referencingTargets,
    boundModels,
    deletableTargets,
    deletableModels,
    deletablePipelines,
    keptTargets,
    keptPipelines,
    brokenPipelines,
  };
}
