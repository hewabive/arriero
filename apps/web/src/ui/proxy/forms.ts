import {
  defaultFusionAnswersTemplate,
  defaultFusionSynthesizerPrompt,
  parseApiProxyBodyFieldPath,
} from "@arriero/core";
import type {
  ApiProxyConditionPredicate,
  ApiProxyConditionScope,
  ApiProxyEditRequestOperation,
  ApiProxyJsonValue,
  ApiProxyModelCreate,
  ApiProxyModelRecord,
  ApiProxyPipelineCreate,
  ApiProxyPipelineNode,
  ApiProxyPipelineRecord,
  ApiProxyOutputLimitConfig,
  ApiProxyOutputLimitMode,
  ApiProxyPortRef,
  ApiProxyQuickRouteCreate,
  ApiProxyReasoningConfig,
  ApiProxyReasoningEffort,
  ApiProxyRouteTo,
  ApiProxyTargetCreate,
  ApiProxyTargetRecord,
} from "@arriero/core";

export type TargetEditor =
  | { mode: "create"; target: null }
  | { mode: "edit"; target: ApiProxyTargetRecord };

export type ModelEditor =
  | { mode: "create"; model: null }
  | { mode: "edit"; model: ApiProxyModelRecord };

export type PipelineEditor =
  | { mode: "create"; pipeline: null }
  | { mode: "edit"; pipeline: ApiProxyPipelineRecord };

export type TargetDraft = {
  name: string;
  endpointId: string | null;
  model: string;
  role: "interactive" | "background";
  priority: number | "";
  preemptible: boolean;
  saveSlotsBeforeUnload: boolean;
  slotIds: string;
  idleUnloadMs: number | "";
};

export type ModelDraft = {
  modelId: string;
  visible: boolean;
  enabled: boolean;
  ownedBy: string;
  routeToValue: string | null;
  description: string;
};

export type QuickRouteDraft = {
  endpointId: string | null;
  model: string;
  targetName: string;
  modelId: string;
};

export type PortValue = string | null;

export type ReplacementRuleDraft = {
  find: string;
  replace: string;
  enabled: boolean;
};

export type EditOperationDraft = {
  kind: ApiProxyEditRequestOperation["kind"];
  toolName: string;
  path: string;
  valueText: string;
  enabled: boolean;
};

export type PipelineNodeDraft = {
  id: string;
  name: string;
  type: ApiProxyPipelineNode["type"];
  captureRequest: boolean;
  captureResponse: boolean;
  replaceRequest: boolean;
  replaceResponse: boolean;
  replaceResponseReasoning: boolean;
  replaceResponseToolArguments: boolean;
  replacements: ReplacementRuleDraft[];
  editOperations: EditOperationDraft[];
  reasoningEffort: ApiProxyReasoningEffort;
  reasoningCustomBudget: number | "";
  outputLimitMax: number | "";
  outputLimitMode: ApiProxyOutputLimitMode;
  cacheTtlSeconds: number | "";
  cacheNamespace: string;
  predicateType: ApiProxyConditionPredicate["type"];
  scope: ApiProxyConditionScope;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  minTokens: number | "";
  sourceId: string;
  callPipelineId: string | null;
  callPorts: Record<string, PortValue>;
  exitName: string;
  fusionPanel: PortValue[];
  fusionSynthesizer: PortValue;
  fusionSynthesizerPrompt: string;
  fusionAnswersTemplate: string;
  fusionMinQuorum: number | "";
  portNext: PortValue;
  portTrue: PortValue;
  portFalse: PortValue;
  layout: { x: number; y: number } | null;
};

export type PipelineDraft = {
  name: string;
  enabled: boolean;
  entryValue: PortValue;
  nodes: PipelineNodeDraft[];
  bindModelIds: string[];
  unbindModelIds: string[];
};

export const unboundTargetValue = "__unbound__";
const routeToTargetPrefix = "target:";
const routeToPipelinePrefix = "pipeline:";

export const emptyTargetDraft: TargetDraft = {
  name: "",
  endpointId: null,
  model: "",
  role: "interactive",
  priority: 100,
  preemptible: true,
  saveSlotsBeforeUnload: false,
  slotIds: "",
  idleUnloadMs: "",
};

export const emptyModelDraft: ModelDraft = {
  modelId: "",
  visible: false,
  enabled: true,
  ownedBy: "arriero",
  routeToValue: null,
  description: "",
};

export const emptyQuickRouteDraft: QuickRouteDraft = {
  endpointId: null,
  model: "",
  targetName: "",
  modelId: "",
};

export const emptyPipelineDraft: PipelineDraft = {
  name: "",
  enabled: true,
  entryValue: null,
  nodes: [],
  bindModelIds: [],
  unbindModelIds: [],
};

export function emptyPipelineNodeDraft(
  id: string,
  type: ApiProxyPipelineNode["type"],
): PipelineNodeDraft {
  return {
    id,
    name: "",
    type,
    captureRequest: true,
    captureResponse: false,
    replaceRequest: true,
    replaceResponse: false,
    replaceResponseReasoning: false,
    replaceResponseToolArguments: false,
    replacements: [],
    editOperations: [],
    reasoningEffort: "medium",
    reasoningCustomBudget: 2048,
    outputLimitMax: 4096,
    outputLimitMode: "cap",
    cacheTtlSeconds: 3600,
    cacheNamespace: "",
    predicateType: "text-match",
    scope: "any-message",
    pattern: "",
    regex: false,
    caseSensitive: false,
    minTokens: "",
    sourceId: "",
    callPipelineId: null,
    callPorts: {},
    exitName: "done",
    fusionPanel: [null, null],
    fusionSynthesizer: null,
    fusionSynthesizerPrompt: defaultFusionSynthesizerPrompt,
    fusionAnswersTemplate: defaultFusionAnswersTemplate,
    fusionMinQuorum: 2,
    portNext: null,
    portTrue: null,
    portFalse: null,
    layout: null,
  };
}

export function nextPipelineNodeId(nodes: PipelineNodeDraft[]): string {
  let index = nodes.length + 1;
  while (nodes.some((node) => node.id === `node-${index}`)) {
    index += 1;
  }
  return `node-${index}`;
}

export function addNodeToDraft(
  draft: PipelineDraft,
  type: ApiProxyPipelineNode["type"],
): PipelineDraft {
  const id = nextPipelineNodeId(draft.nodes);
  const node = emptyPipelineNodeDraft(id, type);
  node.layout = {
    x: 80 + (draft.nodes.length % 3) * 80,
    y: 80 + draft.nodes.length * 60,
  };
  return {
    ...draft,
    entryValue:
      draft.nodes.length === 0 && !draft.entryValue
        ? `node:${id}`
        : draft.entryValue,
    nodes: [...draft.nodes, node],
  };
}

export function addPipelineNodeToDraft(
  draft: PipelineDraft,
  pipelineId: string,
): PipelineDraft {
  const addedId = nextPipelineNodeId(draft.nodes);
  const next = addNodeToDraft(draft, "call");
  return {
    ...next,
    nodes: next.nodes.map((node) =>
      node.id === addedId ? { ...node, callPipelineId: pipelineId } : node,
    ),
  };
}

export function removeNodeFromDraft(
  draft: PipelineDraft,
  nodeId: string,
): PipelineDraft {
  const removedValue = `node:${nodeId}`;
  const clearPort = (value: PortValue) =>
    value === removedValue ? null : value;
  return {
    ...draft,
    entryValue: clearPort(draft.entryValue),
    nodes: draft.nodes
      .filter((node) => node.id !== nodeId)
      .map((node) => ({
        ...node,
        portNext: clearPort(node.portNext),
        portTrue: clearPort(node.portTrue),
        portFalse: clearPort(node.portFalse),
        fusionPanel: node.fusionPanel.map(clearPort),
        fusionSynthesizer: clearPort(node.fusionSynthesizer),
        callPorts: Object.fromEntries(
          Object.entries(node.callPorts).map(([port, value]) => [
            port,
            clearPort(value),
          ]),
        ),
      })),
  };
}

function numberOrNull(value: number | "") {
  return value === "" ? null : value;
}

function slotIdsFromText(value: string) {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function slotIdsText(value: number[]) {
  return value.join(", ");
}

function routeToValue(routeTo: ApiProxyRouteTo | null | undefined) {
  if (!routeTo || routeTo.type === "endpoint") {
    return null;
  }
  return `${routeTo.type}:${routeTo.id}`;
}

function routeToFromValue(value: string | null): ApiProxyRouteTo | null {
  if (!value || value === unboundTargetValue) {
    return null;
  }
  if (value.startsWith(routeToTargetPrefix)) {
    return { type: "target", id: value.slice(routeToTargetPrefix.length) };
  }
  if (value.startsWith(routeToPipelinePrefix)) {
    return { type: "pipeline", id: value.slice(routeToPipelinePrefix.length) };
  }
  return null;
}

export function portRefToValue(ref: ApiProxyPortRef | null): PortValue {
  return ref ? `${ref.type}:${ref.id}` : null;
}

export function portRefFromValue(value: PortValue): ApiProxyPortRef | null {
  if (!value || value === unboundTargetValue) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator < 0) {
    return null;
  }
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if ((type === "node" || type === "target" || type === "pipeline") && id) {
    return { type, id };
  }
  return null;
}

export function targetDraftFromRecord(
  target: ApiProxyTargetRecord,
): TargetDraft {
  return {
    name: target.name,
    endpointId: target.endpointId,
    model: target.model ?? "",
    role: target.role,
    priority: target.priority,
    preemptible: target.preemptible,
    saveSlotsBeforeUnload: target.saveSlotsBeforeUnload,
    slotIds: slotIdsText(target.slotIds),
    idleUnloadMs: target.idleUnloadMs ?? "",
  };
}

export function modelDirectTargetId(model: ApiProxyModelRecord): string | null {
  if (model.routeTo) {
    return model.routeTo.type === "target" ? model.routeTo.id : null;
  }
  return model.targetId;
}

export function modelDraftFromRecord(model: ApiProxyModelRecord): ModelDraft {
  return {
    modelId: model.modelId,
    visible: model.visible,
    enabled: model.enabled,
    ownedBy: model.ownedBy,
    routeToValue: routeToValue(
      model.routeTo ??
        (model.targetId ? { type: "target", id: model.targetId } : null),
    ),
    description: model.description ?? "",
  };
}

function nodeDraftFromRecord(node: ApiProxyPipelineNode): PipelineNodeDraft {
  const draft = emptyPipelineNodeDraft(node.id, node.type);
  draft.name = node.name;
  draft.layout = node.layout ?? null;
  switch (node.type) {
    case "replace-text":
      draft.replacements = node.config.rules.map((rule) => ({
        find: rule.find,
        replace: rule.replace,
        enabled: rule.enabled,
      }));
      draft.replaceRequest = node.config.request;
      draft.replaceResponse = node.config.response;
      draft.replaceResponseReasoning = node.config.responseReasoning;
      draft.replaceResponseToolArguments = node.config.responseToolArguments;
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "capture-request":
      draft.captureRequest = node.config.request;
      draft.captureResponse = node.config.response;
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "edit-request":
      draft.editOperations = node.config.operations.map((operation) => ({
        kind: operation.kind,
        toolName: "toolName" in operation ? operation.toolName : "",
        path: "path" in operation ? operation.path : "",
        valueText:
          "value" in operation ? JSON.stringify(operation.value, null, 2) : "",
        enabled: operation.enabled,
      }));
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "reasoning":
      draft.reasoningEffort = node.config.effort;
      draft.reasoningCustomBudget = node.config.customBudgetTokens;
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "output-limit":
      draft.outputLimitMax = node.config.maxTokens;
      draft.outputLimitMode = node.config.mode;
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "strip-attribution":
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "cache":
      draft.cacheTtlSeconds = node.config.ttlSeconds;
      draft.cacheNamespace = node.config.namespace;
      draft.portNext = portRefToValue(node.ports.next);
      break;
    case "condition": {
      const predicate = node.config.predicate;
      draft.predicateType = predicate.type;
      if (predicate.type === "text-match") {
        draft.scope = predicate.scope;
        draft.pattern = predicate.pattern;
        draft.regex = predicate.regex;
        draft.caseSensitive = predicate.caseSensitive;
      }
      if (predicate.type === "token-estimate") {
        draft.minTokens = predicate.minTokens;
      }
      if (predicate.type === "source") {
        draft.sourceId = predicate.sourceId ?? "";
      }
      draft.portTrue = portRefToValue(node.ports.true);
      draft.portFalse = portRefToValue(node.ports.false);
      break;
    }
    case "call":
      draft.callPipelineId = node.config.pipelineId;
      draft.callPorts = Object.fromEntries(
        Object.entries(node.ports).map(([port, ref]) => [
          port,
          portRefToValue(ref),
        ]),
      );
      break;
    case "exit":
      draft.exitName = node.config.exitName;
      break;
    case "fusion":
      draft.fusionPanel = node.ports.panel.map((ref) => portRefToValue(ref));
      draft.fusionSynthesizer = portRefToValue(node.ports.synthesizer);
      draft.fusionSynthesizerPrompt = node.config.synthesizerPrompt;
      draft.fusionAnswersTemplate = node.config.answersTemplate;
      draft.fusionMinQuorum = node.config.minQuorum;
      break;
  }
  return draft;
}

export function pipelineDraftFromRecord(
  pipeline: ApiProxyPipelineRecord,
): PipelineDraft {
  return {
    name: pipeline.name,
    enabled: pipeline.enabled,
    entryValue: portRefToValue(pipeline.entry),
    nodes: pipeline.nodes.map(nodeDraftFromRecord),
    bindModelIds: [],
    unbindModelIds: [],
  };
}

export function parseEditOperationValue(
  valueText: string,
):
  | { value: Record<string, unknown>; error: null }
  | { value: null; error: string } {
  const trimmed = valueText.trim();
  if (!trimmed) {
    return { value: null, error: "tool JSON is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { value: null, error: `invalid JSON: ${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: null, error: "tool JSON must be a JSON object" };
  }
  return { value: parsed as Record<string, unknown>, error: null };
}

function parseFieldEditValue(
  valueText: string,
): { value: ApiProxyJsonValue; error: null } | { value: null; error: string } {
  const trimmed = valueText.trim();
  if (!trimmed) {
    return { value: null, error: "value JSON is empty" };
  }
  try {
    return { value: JSON.parse(trimmed) as ApiProxyJsonValue, error: null };
  } catch (error) {
    return { value: null, error: `invalid JSON: ${(error as Error).message}` };
  }
}

export function editOperationFromDraft(
  draft: EditOperationDraft,
):
  | { operation: ApiProxyEditRequestOperation; error: null }
  | { operation: null; error: string } {
  if (draft.kind === "set-field" || draft.kind === "remove-field") {
    const path = draft.path.trim();
    if (!path) {
      return { operation: null, error: "field path is empty" };
    }
    if (parseApiProxyBodyFieldPath(path) === null) {
      return { operation: null, error: "invalid field path" };
    }
    if (draft.kind === "remove-field") {
      return {
        operation: { kind: "remove-field", enabled: draft.enabled, path },
        error: null,
      };
    }
    const parsed = parseFieldEditValue(draft.valueText);
    if (parsed.error !== null) {
      return { operation: null, error: parsed.error };
    }
    return {
      operation: {
        kind: "set-field",
        enabled: draft.enabled,
        path,
        value: parsed.value,
      },
      error: null,
    };
  }
  const toolName = draft.toolName.trim();
  if (draft.kind === "remove-tool") {
    if (!toolName) {
      return { operation: null, error: "tool name is empty" };
    }
    return {
      operation: { kind: "remove-tool", enabled: draft.enabled, toolName },
      error: null,
    };
  }
  const parsed = parseEditOperationValue(draft.valueText);
  if (draft.kind === "replace-tool") {
    if (!toolName) {
      return { operation: null, error: "tool name is empty" };
    }
    if (parsed.error !== null) {
      return { operation: null, error: parsed.error };
    }
    return {
      operation: {
        kind: "replace-tool",
        enabled: draft.enabled,
        toolName,
        value: parsed.value,
      },
      error: null,
    };
  }
  if (parsed.error !== null) {
    return { operation: null, error: parsed.error };
  }
  return {
    operation: {
      kind: "add-tool",
      enabled: draft.enabled,
      value: parsed.value,
    },
    error: null,
  };
}

function editOperationsFromDrafts(
  drafts: EditOperationDraft[],
): ApiProxyEditRequestOperation[] {
  const operations: ApiProxyEditRequestOperation[] = [];
  for (const draft of drafts) {
    const blank =
      !draft.toolName.trim() && !draft.path.trim() && !draft.valueText.trim();
    if (blank) {
      continue;
    }
    const result = editOperationFromDraft(draft);
    if (result.operation) {
      operations.push(result.operation);
      continue;
    }
    operations.push({
      kind: draft.kind,
      enabled: draft.enabled,
      toolName: draft.toolName,
      path: draft.path,
      value: draft.valueText,
    } as unknown as ApiProxyEditRequestOperation);
  }
  return operations;
}

function reasoningConfigFromDraft(
  draft: PipelineNodeDraft,
): ApiProxyReasoningConfig {
  return {
    effort: draft.reasoningEffort,
    customBudgetTokens:
      draft.reasoningCustomBudget === "" ? -1 : draft.reasoningCustomBudget,
  };
}

function outputLimitConfigFromDraft(
  draft: PipelineNodeDraft,
): ApiProxyOutputLimitConfig {
  return {
    maxTokens: draft.outputLimitMax === "" ? 4096 : draft.outputLimitMax,
    mode: draft.outputLimitMode,
  };
}

function predicateFromDraft(
  draft: PipelineNodeDraft,
): ApiProxyConditionPredicate {
  if (draft.predicateType === "token-estimate") {
    return {
      type: "token-estimate",
      minTokens: draft.minTokens === "" ? 1 : draft.minTokens,
    };
  }
  if (draft.predicateType === "source") {
    return { type: "source", sourceId: draft.sourceId.trim() || null };
  }
  return {
    type: "text-match",
    scope: draft.scope,
    pattern: draft.pattern,
    regex: draft.regex,
    caseSensitive: draft.caseSensitive,
  };
}

function nodeFromDraft(draft: PipelineNodeDraft): ApiProxyPipelineNode {
  const base = {
    id: draft.id,
    name: draft.name.trim(),
    ...(draft.layout ? { layout: draft.layout } : {}),
  };
  switch (draft.type) {
    case "replace-text":
      return {
        ...base,
        type: "replace-text",
        config: {
          request: draft.replaceRequest,
          response: draft.replaceResponse,
          responseReasoning: draft.replaceResponseReasoning,
          responseToolArguments: draft.replaceResponseToolArguments,
          rules: draft.replacements
            .filter((rule) => rule.find.length > 0)
            .map((rule) => ({
              enabled: rule.enabled,
              find: rule.find,
              replace: rule.replace,
            })),
        },
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "capture-request":
      return {
        ...base,
        type: "capture-request",
        config: {
          request: draft.captureRequest,
          response: draft.captureResponse,
        },
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "edit-request":
      return {
        ...base,
        type: "edit-request",
        config: { operations: editOperationsFromDrafts(draft.editOperations) },
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        config: reasoningConfigFromDraft(draft),
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "output-limit":
      return {
        ...base,
        type: "output-limit",
        config: outputLimitConfigFromDraft(draft),
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "strip-attribution":
      return {
        ...base,
        type: "strip-attribution",
        config: {},
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "cache":
      return {
        ...base,
        type: "cache",
        config: {
          ttlSeconds: draft.cacheTtlSeconds === "" ? 0 : draft.cacheTtlSeconds,
          namespace: draft.cacheNamespace.trim(),
        },
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "condition":
      return {
        ...base,
        type: "condition",
        config: { predicate: predicateFromDraft(draft) },
        ports: {
          true: portRefFromValue(draft.portTrue),
          false: portRefFromValue(draft.portFalse),
        },
      };
    case "call": {
      const ports: Record<string, ApiProxyPortRef> = {};
      for (const [port, value] of Object.entries(draft.callPorts)) {
        const ref = portRefFromValue(value);
        if (ref) {
          ports[port] = ref;
        }
      }
      return {
        ...base,
        type: "call",
        config: { pipelineId: draft.callPipelineId ?? "" },
        ports,
      };
    }
    case "exit":
      return {
        ...base,
        type: "exit",
        config: { exitName: draft.exitName.trim() || "done" },
      };
    case "fusion": {
      const panel = draft.fusionPanel
        .map((value) => portRefFromValue(value))
        .filter((ref): ref is ApiProxyPortRef => ref !== null);
      return {
        ...base,
        type: "fusion",
        config: {
          synthesizerPrompt: draft.fusionSynthesizerPrompt,
          answersTemplate: draft.fusionAnswersTemplate,
          minQuorum: draft.fusionMinQuorum === "" ? 1 : draft.fusionMinQuorum,
        },
        ports: {
          panel,
          synthesizer: portRefFromValue(draft.fusionSynthesizer),
        },
      };
    }
  }
}

export function targetPayload(draft: TargetDraft): ApiProxyTargetCreate {
  return {
    name: draft.name.trim(),
    endpointId: draft.endpointId ?? "",
    model: draft.model.trim() || null,
    role: draft.role,
    priority: draft.priority === "" ? 100 : draft.priority,
    preemptible: draft.preemptible,
    saveSlotsBeforeUnload: draft.saveSlotsBeforeUnload,
    slotIds: slotIdsFromText(draft.slotIds),
    idleUnloadMs: numberOrNull(draft.idleUnloadMs),
  };
}

export function modelPayload(draft: ModelDraft): ApiProxyModelCreate {
  const routeTo = routeToFromValue(draft.routeToValue);
  return {
    modelId: draft.modelId.trim(),
    visible: draft.visible,
    enabled: draft.enabled,
    ownedBy: draft.ownedBy.trim() || "arriero",
    targetId: routeTo?.type === "target" ? routeTo.id : null,
    routeTo,
    description: draft.description.trim() || null,
  };
}

export function quickRoutePayload(
  draft: QuickRouteDraft,
): ApiProxyQuickRouteCreate {
  return {
    targetName: draft.targetName.trim(),
    endpointId: draft.endpointId ?? "",
    model: draft.model.trim() || null,
    modelId: draft.modelId.trim(),
  };
}

export function pipelinePayload(draft: PipelineDraft): ApiProxyPipelineCreate {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    entry: portRefFromValue(draft.entryValue),
    nodes: draft.nodes.map(nodeFromDraft),
  };
}
