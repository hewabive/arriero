import type {
  ApiProxyModelRecord,
  ApiProxyPipelineNode,
  ApiProxyPipelineRecord,
  ApiProxySourceRecord,
  ApiProxyTargetRecord,
} from "@arriero/core";

import type { PipelineDraft, PipelineNodeDraft } from "../forms";

export type PipelineEditorContext = {
  draft: PipelineDraft;
  pipelineId: string | null;
  targets: ApiProxyTargetRecord[];
  pipelines: ApiProxyPipelineRecord[];
  sources: ApiProxySourceRecord[];
  models: ApiProxyModelRecord[];
  updateNode: (nodeId: string, patch: Partial<PipelineNodeDraft>) => void;
};

const nodeTypeLabels: Record<ApiProxyPipelineNode["type"], string> = {
  "replace-text": "Replace text",
  "capture-request": "Save request / response",
  "edit-request": "Edit request",
  reasoning: "Reasoning",
  "output-limit": "Limit output",
  "token-scale": "Token scale",
  "strip-attribution": "Strip CC attribution",
  cache: "Cache response",
  condition: "Condition",
  call: "Pipeline",
  exit: "Exit",
  fusion: "Fusion",
};

export const pipelineNodeTypeOptions: Array<{
  value: ApiProxyPipelineNode["type"];
  label: string;
}> = [
  { value: "replace-text", label: nodeTypeLabels["replace-text"] },
  { value: "capture-request", label: nodeTypeLabels["capture-request"] },
  { value: "edit-request", label: nodeTypeLabels["edit-request"] },
  { value: "reasoning", label: nodeTypeLabels.reasoning },
  { value: "output-limit", label: nodeTypeLabels["output-limit"] },
  { value: "token-scale", label: nodeTypeLabels["token-scale"] },
  {
    value: "strip-attribution",
    label: nodeTypeLabels["strip-attribution"],
  },
  { value: "cache", label: nodeTypeLabels.cache },
  { value: "condition", label: nodeTypeLabels.condition },
  { value: "fusion", label: nodeTypeLabels.fusion },
  { value: "exit", label: nodeTypeLabels.exit },
];

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

export function pipelineNodeTypeLabel(type: ApiProxyPipelineNode["type"]) {
  return nodeTypeLabels[type] ?? type;
}
