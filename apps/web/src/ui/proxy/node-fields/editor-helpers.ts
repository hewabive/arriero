import { collectApiProxyPipelineExitNames } from "@arriero/core";

import type { PipelineNodeDraftOf } from "../forms";
import { unboundTargetValue } from "../forms";
import type { PipelineEditorContext } from "./context";

export function editorOtherPipelines(ctx: PipelineEditorContext) {
  return ctx.pipelines.filter((pipeline) => pipeline.id !== ctx.pipelineId);
}

export function editorPortOptions(
  ctx: PipelineEditorContext,
  excludeNodeId: string | null,
  options?: { includePipelines?: boolean },
) {
  return [
    { value: unboundTargetValue, label: "Unbound" },
    ...ctx.draft.nodes
      .filter((node) => node.id !== excludeNodeId)
      .map((node) => ({
        value: `node:${node.id}`,
        label: `Node: ${node.name || node.id}`,
      })),
    ...ctx.targets.map((target) => ({
      value: `target:${target.id}`,
      label: `Target: ${target.name}`,
    })),
    ...((options?.includePipelines ?? true)
      ? editorOtherPipelines(ctx).map((pipeline) => ({
          value: `pipeline:${pipeline.id}`,
          label: `Pipeline: ${pipeline.name}`,
        }))
      : []),
  ];
}

export function editorCallExitNames(
  ctx: PipelineEditorContext,
  node: PipelineNodeDraftOf<"call">,
): string[] {
  if (!node.callPipelineId) {
    return [];
  }
  const pipelineById = new Map(
    ctx.pipelines.map((pipeline) => [pipeline.id, pipeline]),
  );
  const names = collectApiProxyPipelineExitNames(
    node.callPipelineId,
    (id) => pipelineById.get(id) ?? null,
  );
  for (const port of Object.keys(node.callPorts)) {
    names.add(port);
  }
  return [...names].sort();
}
