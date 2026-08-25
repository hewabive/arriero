import {
  ApiProxyCacheConfigSchema,
  ApiProxyContextLimitConfigSchema,
  ApiProxyLoopGuardConfigSchema,
  ApiProxyOutputLimitConfigSchema,
  ApiProxyReasoningConfigSchema,
  ApiProxyTokenScaleConfigSchema,
  assertNever,
  defaultFusionAnswersTemplate,
  defaultFusionSynthesizerPrompt,
  isApiProxySingleNextNodeType,
  parseApiProxyBodyFieldPath,
} from "@arriero/core";
import type {
  ApiProxyConditionPredicate,
  ApiProxyConditionScope,
  ApiProxyEditRequestOperation,
  ApiProxyJsonValue,
  ApiProxyLoopGuardAction,
  ApiProxyModelCreate,
  ApiProxyModelRecord,
  ApiProxyPipelineCreate,
  ApiProxyPipelineNode,
  ApiProxyPipelineNodeType,
  ApiProxyPipelineRecord,
  ApiProxyOutputLimitConfig,
  ApiProxyOutputLimitMode,
  ApiProxyPortRef,
  ApiProxyQuickRouteCreate,
  ApiProxyReasoningConfig,
  ApiProxyReasoningEffort,
  ApiProxyRouteTo,
  ApiProxySingleNextNodeType,
  ApiProxyTargetCreate,
  ApiProxyTargetRecord,
} from "@arriero/core";

export type TargetEditor =
  | { mode: "create"; target: null }
  | { mode: "edit"; target: ApiProxyTargetRecord };

export type ModelEditor =
  | { mode: "create"; model: null }
  | { mode: "edit"; model: ApiProxyModelRecord };

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
  upstreamModel: string;
  description: string;
  blockedMessage: string;
};

export type QuickRouteDraft = {
  endpointId: string | null;
  model: string;
  targetName: string;
  modelId: string;
};

export type PortValue = string | null;

type ReplacementRuleDraft = {
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

type PipelineNodeDraftBase = {
  id: string;
  name: string;
  layout: { x: number; y: number } | null;
};

export type PipelineNodeDraft =
  | (PipelineNodeDraftBase & {
      type: "replace-text";
      replacements: ReplacementRuleDraft[];
      replaceRequest: boolean;
      replaceResponse: boolean;
      replaceResponseReasoning: boolean;
      replaceResponseToolArguments: boolean;
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "capture-request";
      captureRequest: boolean;
      captureResponse: boolean;
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "edit-request";
      editOperations: EditOperationDraft[];
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "reasoning";
      reasoningEffort: ApiProxyReasoningEffort;
      reasoningCustomBudget: number | "";
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "output-limit";
      outputLimitMax: number | "";
      outputLimitMode: ApiProxyOutputLimitMode;
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "context-limit";
      contextLimitThreshold: number | "";
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "token-scale";
      tokenScaleFactor: number | "";
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "strip-attribution";
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "cache";
      cacheTtlSeconds: number | "";
      cacheNamespace: string;
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "loop-guard";
      loopGuardAction: ApiProxyLoopGuardAction;
      loopGuardAnswer: boolean;
      loopGuardReasoning: boolean;
      loopGuardToolArguments: boolean;
      loopGuardMinSpanChars: number | "";
      loopGuardNoveltyThreshold: number | "";
      loopGuardCompressionThreshold: number | "";
      loopGuardEntropyThreshold: number | "";
      loopGuardPeriodMinRepeats: number | "";
      loopGuardNearMissRatio: number | "";
      loopGuardCaptureTrigger: boolean;
      loopGuardCaptureNearMiss: boolean;
      loopGuardMarkerText: string;
      portNext: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "condition";
      predicateType: ApiProxyConditionPredicate["type"];
      scope: ApiProxyConditionScope;
      pattern: string;
      regex: boolean;
      caseSensitive: boolean;
      minTokens: number | "";
      sourceId: string;
      portTrue: PortValue;
      portFalse: PortValue;
    })
  | (PipelineNodeDraftBase & {
      type: "call";
      callPipelineId: string | null;
      callPorts: Record<string, PortValue>;
    })
  | (PipelineNodeDraftBase & {
      type: "exit";
      exitName: string;
    })
  | (PipelineNodeDraftBase & {
      type: "fusion";
      fusionPanel: PortValue[];
      fusionSynthesizer: PortValue;
      fusionSynthesizerPrompt: string;
      fusionAnswersTemplate: string;
      fusionMinQuorum: number | "";
    });

export type PipelineNodeDraftOf<K extends ApiProxyPipelineNodeType> = Extract<
  PipelineNodeDraft,
  { type: K }
>;

export type PipelineNodeDraftPatch<
  K extends ApiProxyPipelineNodeType = ApiProxyPipelineNodeType,
> = K extends ApiProxyPipelineNodeType
  ? Partial<Omit<PipelineNodeDraftOf<K>, "id" | "type">>
  : never;

export type SingleNextPipelineNodeDraft =
  PipelineNodeDraftOf<ApiProxySingleNextNodeType>;

export function isSingleNextPipelineNodeDraft(
  node: PipelineNodeDraft,
): node is SingleNextPipelineNodeDraft {
  return isApiProxySingleNextNodeType(node.type);
}

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
export const routeToEndpointPrefix = "endpoint:";

export function isEndpointRouteValue(value: string | null): boolean {
  return value !== null && value.startsWith(routeToEndpointPrefix);
}

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
  upstreamModel: "",
  description: "",
  blockedMessage: "",
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

const loopGuardDefaults = ApiProxyLoopGuardConfigSchema.parse({});
const reasoningDefaults = ApiProxyReasoningConfigSchema.parse({});
const outputLimitDefaults = ApiProxyOutputLimitConfigSchema.parse({});
const contextLimitDefaults = ApiProxyContextLimitConfigSchema.parse({});
const tokenScaleDefaults = ApiProxyTokenScaleConfigSchema.parse({});
const cacheDefaults = ApiProxyCacheConfigSchema.parse({});

const pipelineNodeDraftFactories: {
  [K in ApiProxyPipelineNodeType]: (
    base: PipelineNodeDraftBase,
  ) => PipelineNodeDraftOf<K>;
} = {
  "replace-text": (base) => ({
    ...base,
    type: "replace-text",
    replacements: [],
    replaceRequest: true,
    replaceResponse: false,
    replaceResponseReasoning: false,
    replaceResponseToolArguments: false,
    portNext: null,
  }),
  "capture-request": (base) => ({
    ...base,
    type: "capture-request",
    captureRequest: true,
    captureResponse: false,
    portNext: null,
  }),
  "edit-request": (base) => ({
    ...base,
    type: "edit-request",
    editOperations: [],
    portNext: null,
  }),
  reasoning: (base) => ({
    ...base,
    type: "reasoning",
    reasoningEffort: reasoningDefaults.effort,
    reasoningCustomBudget: reasoningDefaults.customBudgetTokens,
    portNext: null,
  }),
  "output-limit": (base) => ({
    ...base,
    type: "output-limit",
    outputLimitMax: outputLimitDefaults.maxTokens,
    outputLimitMode: outputLimitDefaults.mode,
    portNext: null,
  }),
  "context-limit": (base) => ({
    ...base,
    type: "context-limit",
    contextLimitThreshold: contextLimitDefaults.thresholdTokens,
    portNext: null,
  }),
  "token-scale": (base) => ({
    ...base,
    type: "token-scale",
    tokenScaleFactor: tokenScaleDefaults.factor,
    portNext: null,
  }),
  "strip-attribution": (base) => ({
    ...base,
    type: "strip-attribution",
    portNext: null,
  }),
  cache: (base) => ({
    ...base,
    type: "cache",
    cacheTtlSeconds: cacheDefaults.ttlSeconds,
    cacheNamespace: cacheDefaults.namespace,
    portNext: null,
  }),
  "loop-guard": (base) => ({
    ...base,
    type: "loop-guard",
    loopGuardAction: loopGuardDefaults.action,
    loopGuardAnswer: loopGuardDefaults.answer,
    loopGuardReasoning: loopGuardDefaults.reasoning,
    loopGuardToolArguments: loopGuardDefaults.toolArguments,
    loopGuardMinSpanChars: loopGuardDefaults.minSpanChars,
    loopGuardNoveltyThreshold: loopGuardDefaults.noveltyThreshold,
    loopGuardCompressionThreshold: loopGuardDefaults.compressionThreshold,
    loopGuardEntropyThreshold: loopGuardDefaults.entropyThreshold,
    loopGuardPeriodMinRepeats: loopGuardDefaults.periodMinRepeats,
    loopGuardNearMissRatio: loopGuardDefaults.nearMissRatio,
    loopGuardCaptureTrigger: loopGuardDefaults.captureTrigger,
    loopGuardCaptureNearMiss: loopGuardDefaults.captureNearMiss,
    loopGuardMarkerText: loopGuardDefaults.markerText,
    portNext: null,
  }),
  condition: (base) => ({
    ...base,
    type: "condition",
    predicateType: "text-match",
    scope: "any-message",
    pattern: "",
    regex: false,
    caseSensitive: false,
    minTokens: "",
    sourceId: "",
    portTrue: null,
    portFalse: null,
  }),
  call: (base) => ({
    ...base,
    type: "call",
    callPipelineId: null,
    callPorts: {},
  }),
  exit: (base) => ({
    ...base,
    type: "exit",
    exitName: "done",
  }),
  fusion: (base) => ({
    ...base,
    type: "fusion",
    fusionPanel: [null, null],
    fusionSynthesizer: null,
    fusionSynthesizerPrompt: defaultFusionSynthesizerPrompt,
    fusionAnswersTemplate: defaultFusionAnswersTemplate,
    fusionMinQuorum: 2,
  }),
};

function emptyPipelineNodeDraft(
  id: string,
  type: ApiProxyPipelineNodeType,
): PipelineNodeDraft {
  return pipelineNodeDraftFactories[type]({ id, name: "", layout: null });
}

function nextPipelineNodeId(nodes: PipelineNodeDraft[]): string {
  let index = nodes.length + 1;
  while (nodes.some((node) => node.id === `node-${index}`)) {
    index += 1;
  }
  return `node-${index}`;
}

export function addNodeToDraft(
  draft: PipelineDraft,
  type: ApiProxyPipelineNodeType,
): PipelineDraft {
  const id = nextPipelineNodeId(draft.nodes);
  const node = {
    ...emptyPipelineNodeDraft(id, type),
    layout: {
      x: 80 + (draft.nodes.length % 3) * 80,
      y: 80 + draft.nodes.length * 60,
    },
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
      node.id === addedId && node.type === "call"
        ? { ...node, callPipelineId: pipelineId }
        : node,
    ),
  };
}

function clearPipelineNodeDraftPorts(
  node: PipelineNodeDraft,
  removedValue: string,
): PipelineNodeDraft {
  const clearPort = (value: PortValue) =>
    value === removedValue ? null : value;
  if (isSingleNextPipelineNodeDraft(node)) {
    return { ...node, portNext: clearPort(node.portNext) };
  }
  switch (node.type) {
    case "condition":
      return {
        ...node,
        portTrue: clearPort(node.portTrue),
        portFalse: clearPort(node.portFalse),
      };
    case "call":
      return {
        ...node,
        callPorts: Object.fromEntries(
          Object.entries(node.callPorts).map(([port, value]) => [
            port,
            clearPort(value),
          ]),
        ),
      };
    case "exit":
      return node;
    case "fusion":
      return {
        ...node,
        fusionPanel: node.fusionPanel.map(clearPort),
        fusionSynthesizer: clearPort(node.fusionSynthesizer),
      };
    default:
      return assertNever(node);
  }
}

export function removeNodeFromDraft(
  draft: PipelineDraft,
  nodeId: string,
): PipelineDraft {
  const removedValue = `node:${nodeId}`;
  return {
    ...draft,
    entryValue: draft.entryValue === removedValue ? null : draft.entryValue,
    nodes: draft.nodes
      .filter((node) => node.id !== nodeId)
      .map((node) => clearPipelineNodeDraftPorts(node, removedValue)),
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
  if (!routeTo) {
    return null;
  }
  if (routeTo.type === "endpoint") {
    return `${routeToEndpointPrefix}${routeTo.endpointId}`;
  }
  return `${routeTo.type}:${routeTo.id}`;
}

function routeToFromValue(
  value: string | null,
  upstreamModel: string | null,
): ApiProxyRouteTo | null {
  if (!value || value === unboundTargetValue) {
    return null;
  }
  if (value.startsWith(routeToTargetPrefix)) {
    return { type: "target", id: value.slice(routeToTargetPrefix.length) };
  }
  if (value.startsWith(routeToPipelinePrefix)) {
    return { type: "pipeline", id: value.slice(routeToPipelinePrefix.length) };
  }
  if (value.startsWith(routeToEndpointPrefix)) {
    return {
      type: "endpoint",
      endpointId: value.slice(routeToEndpointPrefix.length),
      upstreamModel,
    };
  }
  return null;
}

function portRefToValue(ref: ApiProxyPortRef | null): PortValue {
  return ref ? `${ref.type}:${ref.id}` : null;
}

function portRefFromValue(value: PortValue): ApiProxyPortRef | null {
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
    upstreamModel:
      model.routeTo?.type === "endpoint"
        ? (model.routeTo.upstreamModel ?? "")
        : "",
    description: model.description ?? "",
    blockedMessage: model.blockedMessage,
  };
}

function nodeDraftFromRecord(node: ApiProxyPipelineNode): PipelineNodeDraft {
  const base = { id: node.id, name: node.name, layout: node.layout ?? null };
  switch (node.type) {
    case "replace-text":
      return {
        ...base,
        type: "replace-text",
        replacements: node.config.rules.map((rule) => ({
          find: rule.find,
          replace: rule.replace,
          enabled: rule.enabled,
        })),
        replaceRequest: node.config.request,
        replaceResponse: node.config.response,
        replaceResponseReasoning: node.config.responseReasoning,
        replaceResponseToolArguments: node.config.responseToolArguments,
        portNext: portRefToValue(node.ports.next),
      };
    case "capture-request":
      return {
        ...base,
        type: "capture-request",
        captureRequest: node.config.request,
        captureResponse: node.config.response,
        portNext: portRefToValue(node.ports.next),
      };
    case "edit-request":
      return {
        ...base,
        type: "edit-request",
        editOperations: node.config.operations.map((operation) => ({
          kind: operation.kind,
          toolName: "toolName" in operation ? operation.toolName : "",
          path: "path" in operation ? operation.path : "",
          valueText:
            "value" in operation
              ? JSON.stringify(operation.value, null, 2)
              : "",
          enabled: operation.enabled,
        })),
        portNext: portRefToValue(node.ports.next),
      };
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        reasoningEffort: node.config.effort,
        reasoningCustomBudget: node.config.customBudgetTokens,
        portNext: portRefToValue(node.ports.next),
      };
    case "output-limit":
      return {
        ...base,
        type: "output-limit",
        outputLimitMax: node.config.maxTokens,
        outputLimitMode: node.config.mode,
        portNext: portRefToValue(node.ports.next),
      };
    case "context-limit":
      return {
        ...base,
        type: "context-limit",
        contextLimitThreshold: node.config.thresholdTokens,
        portNext: portRefToValue(node.ports.next),
      };
    case "token-scale":
      return {
        ...base,
        type: "token-scale",
        tokenScaleFactor: node.config.factor,
        portNext: portRefToValue(node.ports.next),
      };
    case "strip-attribution":
      return {
        ...base,
        type: "strip-attribution",
        portNext: portRefToValue(node.ports.next),
      };
    case "cache":
      return {
        ...base,
        type: "cache",
        cacheTtlSeconds: node.config.ttlSeconds,
        cacheNamespace: node.config.namespace,
        portNext: portRefToValue(node.ports.next),
      };
    case "loop-guard":
      return {
        ...base,
        type: "loop-guard",
        loopGuardAction: node.config.action,
        loopGuardAnswer: node.config.answer,
        loopGuardReasoning: node.config.reasoning,
        loopGuardToolArguments: node.config.toolArguments,
        loopGuardMinSpanChars: node.config.minSpanChars,
        loopGuardNoveltyThreshold: node.config.noveltyThreshold,
        loopGuardCompressionThreshold: node.config.compressionThreshold,
        loopGuardEntropyThreshold: node.config.entropyThreshold,
        loopGuardPeriodMinRepeats: node.config.periodMinRepeats,
        loopGuardNearMissRatio: node.config.nearMissRatio,
        loopGuardCaptureTrigger: node.config.captureTrigger,
        loopGuardCaptureNearMiss: node.config.captureNearMiss,
        loopGuardMarkerText: node.config.markerText,
        portNext: portRefToValue(node.ports.next),
      };
    case "condition": {
      const predicate = node.config.predicate;
      return {
        ...base,
        type: "condition",
        predicateType: predicate.type,
        scope:
          predicate.type === "text-match" ? predicate.scope : "any-message",
        pattern: predicate.type === "text-match" ? predicate.pattern : "",
        regex: predicate.type === "text-match" ? predicate.regex : false,
        caseSensitive:
          predicate.type === "text-match" ? predicate.caseSensitive : false,
        minTokens:
          predicate.type === "token-estimate" ? predicate.minTokens : "",
        sourceId: predicate.type === "source" ? (predicate.sourceId ?? "") : "",
        portTrue: portRefToValue(node.ports.true),
        portFalse: portRefToValue(node.ports.false),
      };
    }
    case "call":
      return {
        ...base,
        type: "call",
        callPipelineId: node.config.pipelineId,
        callPorts: Object.fromEntries(
          Object.entries(node.ports).map(([port, ref]) => [
            port,
            portRefToValue(ref),
          ]),
        ),
      };
    case "exit":
      return {
        ...base,
        type: "exit",
        exitName: node.config.exitName,
      };
    case "fusion":
      return {
        ...base,
        type: "fusion",
        fusionPanel: node.ports.panel.map((ref) => portRefToValue(ref)),
        fusionSynthesizer: portRefToValue(node.ports.synthesizer),
        fusionSynthesizerPrompt: node.config.synthesizerPrompt,
        fusionAnswersTemplate: node.config.answersTemplate,
        fusionMinQuorum: node.config.minQuorum,
      };
    default:
      return assertNever(node);
  }
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

function parseEditOperationValue(
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
  draft: PipelineNodeDraftOf<"reasoning">,
): ApiProxyReasoningConfig {
  return {
    effort: draft.reasoningEffort,
    customBudgetTokens:
      draft.reasoningCustomBudget === "" ? -1 : draft.reasoningCustomBudget,
  };
}

function outputLimitConfigFromDraft(
  draft: PipelineNodeDraftOf<"output-limit">,
): ApiProxyOutputLimitConfig {
  return {
    maxTokens:
      draft.outputLimitMax === ""
        ? outputLimitDefaults.maxTokens
        : draft.outputLimitMax,
    mode: draft.outputLimitMode,
  };
}

function predicateFromDraft(
  draft: PipelineNodeDraftOf<"condition">,
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
    case "context-limit":
      return {
        ...base,
        type: "context-limit",
        config: {
          thresholdTokens:
            draft.contextLimitThreshold === ""
              ? contextLimitDefaults.thresholdTokens
              : draft.contextLimitThreshold,
        },
        ports: { next: portRefFromValue(draft.portNext) },
      };
    case "token-scale":
      return {
        ...base,
        type: "token-scale",
        config: {
          factor:
            draft.tokenScaleFactor === ""
              ? tokenScaleDefaults.factor
              : draft.tokenScaleFactor,
        },
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
    case "loop-guard":
      return {
        ...base,
        type: "loop-guard",
        config: {
          action: draft.loopGuardAction,
          answer: draft.loopGuardAnswer,
          reasoning: draft.loopGuardReasoning,
          toolArguments: draft.loopGuardToolArguments,
          minSpanChars:
            draft.loopGuardMinSpanChars === ""
              ? loopGuardDefaults.minSpanChars
              : draft.loopGuardMinSpanChars,
          noveltyThreshold:
            draft.loopGuardNoveltyThreshold === ""
              ? loopGuardDefaults.noveltyThreshold
              : draft.loopGuardNoveltyThreshold,
          compressionThreshold:
            draft.loopGuardCompressionThreshold === ""
              ? loopGuardDefaults.compressionThreshold
              : draft.loopGuardCompressionThreshold,
          entropyThreshold:
            draft.loopGuardEntropyThreshold === ""
              ? loopGuardDefaults.entropyThreshold
              : draft.loopGuardEntropyThreshold,
          periodMinRepeats:
            draft.loopGuardPeriodMinRepeats === ""
              ? loopGuardDefaults.periodMinRepeats
              : draft.loopGuardPeriodMinRepeats,
          nearMissRatio:
            draft.loopGuardNearMissRatio === ""
              ? loopGuardDefaults.nearMissRatio
              : draft.loopGuardNearMissRatio,
          captureTrigger: draft.loopGuardCaptureTrigger,
          captureNearMiss: draft.loopGuardCaptureNearMiss,
          markerText: draft.loopGuardMarkerText,
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
    default:
      return assertNever(draft);
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
  const routeTo = routeToFromValue(
    draft.routeToValue,
    draft.upstreamModel.trim() || null,
  );
  return {
    modelId: draft.modelId.trim(),
    visible: draft.visible,
    enabled: draft.enabled,
    ownedBy: draft.ownedBy.trim() || "arriero",
    targetId: routeTo?.type === "target" ? routeTo.id : null,
    routeTo,
    description: draft.description.trim() || null,
    blockedMessage: draft.blockedMessage.trim(),
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
