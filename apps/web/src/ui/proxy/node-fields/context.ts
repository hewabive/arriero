import {
  PIPELINE_NODE_TYPES,
  pipelineNodeDescriptor,
  type ApiProxyModelRecord,
  type ApiProxyPipelineNodeType,
  type ApiProxyPipelineRecord,
  type ApiProxySourceRecord,
  type ApiProxyTargetRecord,
} from "@arriero/core";

import type { PipelineDraft, PipelineNodeDraftPatch } from "../forms";

export type PipelineEditorContext = {
  draft: PipelineDraft;
  pipelineId: string | null;
  targets: ApiProxyTargetRecord[];
  pipelines: ApiProxyPipelineRecord[];
  sources: ApiProxySourceRecord[];
  models: ApiProxyModelRecord[];
  updateNode: (nodeId: string, patch: PipelineNodeDraftPatch) => void;
};

export const pipelineNodeTypeOptions: Array<{
  value: ApiProxyPipelineNodeType;
  label: string;
}> = PIPELINE_NODE_TYPES.filter(
  (type) => pipelineNodeDescriptor(type).pickerVisible,
).map((type) => ({ value: type, label: pipelineNodeDescriptor(type).label }));

export const reasoningEffortOptions = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
  { value: "custom", label: "Custom" },
];

export const outputLimitModeOptions = [
  { value: "cap", label: "Cap" },
  { value: "set", label: "Set" },
];

export const conditionScopeOptions = [
  { value: "last-user-message", label: "Last user message" },
  { value: "any-message", label: "Any message" },
  { value: "system", label: "System prompt" },
  { value: "full-body", label: "Full request body" },
];

export const predicateTypeOptions = [
  { value: "text-match", label: "Text match" },
  { value: "token-estimate", label: "Token estimate" },
  { value: "source", label: "Request source" },
];

export const anonymousSourceValue = "__anonymous__";

export function pipelineNodeTypeLabel(type: ApiProxyPipelineNodeType) {
  return pipelineNodeDescriptor(type).label;
}
