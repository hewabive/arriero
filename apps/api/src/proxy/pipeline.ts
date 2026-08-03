import {
  apiProxyOutputLimitEditOperations,
  apiProxyReasoningEditOperations,
  apiProxyTokenScaleEditOperations,
  applyApiProxyTextReplacements,
  applyApiProxyRequestEdits,
  resolveApiProxyReasoning,
  type ApiProxyPipelineNode,
  type ApiProxyPipelineRecord,
  type ApiProxyPortRef,
  type ApiProxyReasoningConfig,
  type ApiProxyRouteTo,
  type ApiProxyRouteTraceStep,
  type ApiProxyTextReplacementRule,
} from "@arriero/core";

import { sanitizeClaudeCodeAttribution } from "./attribution.js";
import { evaluateApiProxyCondition } from "./condition.js";
import { contextOverflowMessage } from "./context-overflow.js";
import { apiProxyResponseCacheKey } from "./response-cache-key.js";
import {
  bodyRequestsStreaming,
  type ApiProxyProtocolDiagnostic,
  type ApiProxyProtocolModelRequest,
} from "./protocol.js";
import { estimateRequestTokens } from "./token-estimate.js";

export type ApiProxyPipelineRecordRequestInput = {
  kind: string;
  nodeName: string | null;
  protocol: "openai" | "anthropic";
  endpoint: string;
  routePath: string;
  modelId: string;
  requestBody: unknown;
};

type ApiProxyCaptureResponseEffect = {
  type: "capture-response";
  nodeName: string | null;
};

export type ApiProxyCacheStoreEffect = {
  type: "cache-store";
  key: string;
  ttlSeconds: number;
};

export type ApiProxyReplaceResponseTextEffect = {
  type: "replace-response-text";
  rules: ApiProxyTextReplacementRule[];
  includeReasoning: boolean;
  includeToolArguments: boolean;
};

type ApiProxyTokenScaleResponseEffect = {
  type: "token-scale";
  factor: number;
};

export type ApiProxyResponseEffect =
  | ApiProxyCaptureResponseEffect
  | ApiProxyCacheStoreEffect
  | ApiProxyReplaceResponseTextEffect
  | ApiProxyTokenScaleResponseEffect;

export function apiProxyCacheStores(
  effects: ApiProxyResponseEffect[],
): ApiProxyCacheStoreEffect[] {
  return effects.filter(
    (effect): effect is ApiProxyCacheStoreEffect =>
      effect.type === "cache-store",
  );
}

export type ApiProxyCachedResponsePayload = {
  status: number;
  contentType: string;
  isSse: boolean;
  body: string;
};

type ApiProxyResponseResult = {
  status: number;
  contentType: string;
  body: string | ReadableStream<Uint8Array>;
};

export type ApiProxyBroadcastSubscription = {
  contentType: string;
  body: ReadableStream<Uint8Array>;
};

export type ApiProxyCacheLookup = (
  key: string,
) =>
  | ApiProxyCachedResponsePayload
  | null
  | Promise<ApiProxyCachedResponsePayload | null>;

export type ApiProxyFusionNode = Extract<
  ApiProxyPipelineNode,
  { type: "fusion" }
>;

export type ApiProxyRouteChainResult =
  | {
      ok: true;
      kind: "target";
      request: ApiProxyProtocolModelRequest;
      targetId: string;
      textReplacementCount: number;
      responseEffects: ApiProxyResponseEffect[];
      routeTrace: ApiProxyRouteTraceStep[];
    }
  | {
      ok: true;
      kind: "fusion";
      request: ApiProxyProtocolModelRequest;
      node: ApiProxyFusionNode;
      pipeline: ApiProxyPipelineRecord;
      textReplacementCount: number;
      responseEffects: ApiProxyResponseEffect[];
      routeTrace: ApiProxyRouteTraceStep[];
    }
  | {
      ok: true;
      kind: "endpoint";
      request: ApiProxyProtocolModelRequest;
      endpointId: string;
      upstreamModel: string | null;
      textReplacementCount: number;
      responseEffects: ApiProxyResponseEffect[];
      routeTrace: ApiProxyRouteTraceStep[];
    }
  | {
      ok: true;
      kind: "response";
      source: "store" | "coalesced";
      request: ApiProxyProtocolModelRequest;
      response: ApiProxyResponseResult;
      cacheKey: string;
      textReplacementCount: number;
      responseEffects: ApiProxyResponseEffect[];
      routeTrace: ApiProxyRouteTraceStep[];
    }
  | {
      ok: false;
      diagnostic: ApiProxyProtocolDiagnostic;
      responseEffects: ApiProxyResponseEffect[];
      routeTrace: ApiProxyRouteTraceStep[];
    };

type ReplacementResult = {
  value: unknown;
  count: number;
};

const replacementExcludedKeys = new Set(["model"]);

export function replaceRequestText(
  value: unknown,
  rules: ApiProxyTextReplacementRule[],
  key: string | null = null,
): ReplacementResult {
  if (typeof value === "string") {
    if (key && replacementExcludedKeys.has(key)) {
      return { value, count: 0 };
    }
    const replacement = applyApiProxyTextReplacements(value, rules);
    return { value: replacement.text, count: replacement.count };
  }

  if (Array.isArray(value)) {
    let count = 0;
    const next = value.map((item) => {
      const result = replaceRequestText(item, rules);
      count += result.count;
      return result.value;
    });
    return { value: next, count };
  }

  if (value && typeof value === "object") {
    let count = 0;
    const next: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const result = replaceRequestText(entryValue, rules, entryKey);
      count += result.count;
      next[entryKey] = result.value;
    }
    return { value: next, count };
  }

  return { value, count: 0 };
}

function legacyModelRouteTo(request: ApiProxyProtocolModelRequest) {
  return (
    request.model.routeTo ??
    (request.model.targetId
      ? ({
          type: "target",
          id: request.model.targetId,
        } satisfies ApiProxyRouteTo)
      : null)
  );
}

type CallNode = Extract<ApiProxyPipelineNode, { type: "call" }>;

type CallFrame = {
  ownerPipeline: ApiProxyPipelineRecord;
  node: CallNode;
  calleeId: string;
};

type RouteWalkState = {
  request: ApiProxyProtocolModelRequest;
  textReplacementCount: number;
  responseEffects: ApiProxyResponseEffect[];
  routeTrace: ApiProxyRouteTraceStep[];
};

const defaultMaxVisitedNodes = 256;
const defaultMaxCallDepth = 8;

function traceStep(
  step: Partial<ApiProxyRouteTraceStep> & Pick<ApiProxyRouteTraceStep, "kind">,
): ApiProxyRouteTraceStep {
  return {
    pipelineId: null,
    pipelineName: null,
    nodeId: null,
    nodeName: null,
    port: null,
    detail: null,
    ...step,
  };
}

function nodeStep(
  pipeline: ApiProxyPipelineRecord,
  node: ApiProxyPipelineNode,
  extra: Partial<ApiProxyRouteTraceStep> = {},
): ApiProxyRouteTraceStep {
  return traceStep({
    kind: node.type,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    nodeId: node.id,
    nodeName: node.name || null,
    ...extra,
  });
}

function routeDiagnostic(
  status: 400 | 503,
  code: ApiProxyProtocolDiagnostic["code"],
  message: string,
  param: string | null = "model",
): ApiProxyProtocolDiagnostic {
  return { status, code, param, message };
}

function reasoningTraceDetail(config: ApiProxyReasoningConfig): string {
  const { enableThinking, budget } = resolveApiProxyReasoning(config);
  if (!enableThinking) {
    return "thinking off";
  }
  if (budget === null || budget < 0) {
    return `${config.effort} · unlimited budget`;
  }
  return `${config.effort} · ${budget} token budget`;
}

export async function resolveApiProxyRouteChain(input: {
  request: ApiProxyProtocolModelRequest;
  getPipeline: (pipelineId: string) => ApiProxyPipelineRecord | null;
  sourceId?: string | null | undefined;
  entry?:
    | { ref: ApiProxyPortRef; pipeline: ApiProxyPipelineRecord }
    | undefined;
  recordRequest?: (
    request: ApiProxyPipelineRecordRequestInput,
  ) => void | Promise<void>;
  lookupCache?: ApiProxyCacheLookup | undefined;
  findInFlight?:
    | ((key: string) => Promise<ApiProxyCachedResponsePayload | null> | null)
    | undefined;
  registerOwner?: ((key: string) => void) | undefined;
  findBroadcast?:
    | ((key: string) => ApiProxyBroadcastSubscription | null)
    | undefined;
  registerBroadcast?: ((key: string) => void) | undefined;
  ownedKeys?: ReadonlySet<string> | undefined;
  maxVisitedNodes?: number | undefined;
  maxCallDepth?: number | undefined;
}): Promise<ApiProxyRouteChainResult> {
  const maxVisitedNodes = input.maxVisitedNodes ?? defaultMaxVisitedNodes;
  const maxCallDepth = input.maxCallDepth ?? defaultMaxCallDepth;
  const sourceId = input.sourceId ?? null;

  const state: RouteWalkState = {
    request: input.request,
    textReplacementCount: 0,
    responseEffects: [],
    routeTrace: [],
  };

  let tokenEstimate: number | null = null;
  const estimateTokens = () =>
    (tokenEstimate ??= estimateRequestTokens(state.request.body));

  const callStack: CallFrame[] = [];
  let currentPipeline: ApiProxyPipelineRecord | null =
    input.entry?.pipeline ?? null;
  let visitedNodes = 0;

  const fail = (diagnostic: ApiProxyProtocolDiagnostic) => {
    return {
      ok: false as const,
      diagnostic,
      responseEffects: state.responseEffects,
      routeTrace: state.routeTrace,
    };
  };

  const modelId = input.request.modelId;
  let ref: ApiProxyPortRef | ApiProxyRouteTo | null = input.entry
    ? input.entry.ref
    : legacyModelRouteTo(input.request);

  while (true) {
    if (!ref) {
      return fail(
        routeDiagnostic(
          503,
          "arriero_proxy_route_unbound",
          currentPipeline
            ? `Proxy route for model ${modelId} ends at an unwired port in pipeline ${currentPipeline.name}.`
            : `Model ${modelId} is not routed to a pipeline or target.`,
        ),
      );
    }

    if (ref.type === "target") {
      return {
        ok: true,
        kind: "target",
        request: state.request,
        targetId: ref.id,
        textReplacementCount: state.textReplacementCount,
        responseEffects: state.responseEffects,
        routeTrace: state.routeTrace,
      };
    }

    if (ref.type === "endpoint") {
      return {
        ok: true,
        kind: "endpoint",
        request: state.request,
        endpointId: ref.endpointId,
        upstreamModel: ref.upstreamModel,
        textReplacementCount: state.textReplacementCount,
        responseEffects: state.responseEffects,
        routeTrace: state.routeTrace,
      };
    }

    if (ref.type === "pipeline") {
      const pipeline = input.getPipeline(ref.id);
      if (!pipeline) {
        return fail(
          routeDiagnostic(
            503,
            "arriero_proxy_pipeline_not_found",
            `Proxy route for model ${modelId} points to missing pipeline ${ref.id}.`,
          ),
        );
      }
      if (!pipeline.enabled) {
        return fail(
          routeDiagnostic(
            503,
            "arriero_proxy_pipeline_disabled",
            `Proxy route for model ${modelId} points to disabled pipeline ${pipeline.name}.`,
          ),
        );
      }
      currentPipeline = pipeline;
      state.routeTrace.push(
        traceStep({
          kind: "enter-pipeline",
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
        }),
      );
      ref = pipeline.entry;
      continue;
    }

    if (!currentPipeline) {
      return fail(
        routeDiagnostic(
          503,
          "arriero_proxy_route_invalid",
          `Proxy route for model ${modelId} references node ${ref.id} outside of a pipeline.`,
        ),
      );
    }

    const pipeline = currentPipeline;
    const nodeId: string = ref.id;
    const node: ApiProxyPipelineNode | undefined = pipeline.nodes.find(
      (item) => item.id === nodeId,
    );
    if (!node) {
      return fail(
        routeDiagnostic(
          503,
          "arriero_proxy_route_invalid",
          `Pipeline ${pipeline.name} has no node ${nodeId} (route for model ${modelId}).`,
        ),
      );
    }

    visitedNodes += 1;
    if (visitedNodes > maxVisitedNodes) {
      return fail(
        routeDiagnostic(
          503,
          "arriero_proxy_pipeline_cycle",
          `Proxy route for model ${modelId} exceeded ${maxVisitedNodes} routing nodes (possible cycle).`,
        ),
      );
    }

    switch (node.type) {
      case "replace-text": {
        const replacement = node.config.request
          ? replaceRequestText(state.request.body, node.config.rules)
          : { value: state.request.body, count: 0 };
        if (replacement.count > 0) {
          state.request = {
            ...state.request,
            body: replacement.value,
            stream: bodyRequestsStreaming(replacement.value),
          };
          state.textReplacementCount += replacement.count;
          tokenEstimate = null;
        }
        if (node.config.response) {
          state.responseEffects.push({
            type: "replace-response-text",
            rules: node.config.rules,
            includeReasoning: node.config.responseReasoning,
            includeToolArguments: node.config.responseToolArguments,
          });
        }
        const details = [
          node.config.request
            ? `request: ${replacement.count} replacement(s)`
            : "request: disabled",
          node.config.response ? "response at completion" : null,
        ].filter((detail): detail is string => detail !== null);
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail: details.join(" · "),
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "edit-request": {
        const edit = applyApiProxyRequestEdits(
          state.request.body,
          node.config.operations,
        );
        if (edit.changed) {
          state.request = {
            ...state.request,
            body: edit.body,
            stream: bodyRequestsStreaming(edit.body),
          };
          tokenEstimate = null;
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail:
              edit.outcomes.length > 0
                ? edit.outcomes.map((outcome) => outcome.detail).join("; ")
                : "no operations",
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "reasoning": {
        const operations = apiProxyReasoningEditOperations(
          node.config,
          input.request.operation.protocol,
        );
        const edit = applyApiProxyRequestEdits(state.request.body, operations);
        if (edit.changed) {
          state.request = {
            ...state.request,
            body: edit.body,
            stream: bodyRequestsStreaming(edit.body),
          };
          tokenEstimate = null;
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail: reasoningTraceDetail(node.config),
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "output-limit": {
        const operations = apiProxyOutputLimitEditOperations(
          node.config,
          state.request.body,
        );
        const edit = applyApiProxyRequestEdits(state.request.body, operations);
        if (edit.changed) {
          state.request = {
            ...state.request,
            body: edit.body,
            stream: bodyRequestsStreaming(edit.body),
          };
          tokenEstimate = null;
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail:
              edit.outcomes.length > 0
                ? edit.outcomes.map((outcome) => outcome.detail).join("; ")
                : `${node.config.mode} ${node.config.maxTokens}: no change`,
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "context-limit": {
        const estimatedTokens = estimateTokens();
        const rejected = estimatedTokens >= node.config.thresholdTokens;
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: rejected ? null : "next",
            detail: `estimated ${estimatedTokens} / threshold ${node.config.thresholdTokens} tokens${rejected ? " · rejected" : ""}`,
          }),
        );
        if (rejected) {
          return fail(
            routeDiagnostic(
              400,
              "arriero_proxy_context_overflow",
              contextOverflowMessage,
              null,
            ),
          );
        }
        ref = node.ports.next;
        break;
      }
      case "token-scale": {
        const operations = apiProxyTokenScaleEditOperations(
          node.config.factor,
          state.request.body,
        );
        const edit = applyApiProxyRequestEdits(state.request.body, operations);
        if (edit.changed) {
          state.request = { ...state.request, body: edit.body };
        }
        if (node.config.factor !== 1) {
          state.responseEffects.push({
            type: "token-scale",
            factor: node.config.factor,
          });
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail:
              node.config.factor === 1
                ? "factor 1 (no-op)"
                : `factor ${node.config.factor} · ${
                    edit.outcomes.length > 0
                      ? edit.outcomes
                          .map((outcome) => outcome.detail)
                          .join("; ")
                      : "no request fields"
                  }`,
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "strip-attribution": {
        const sanitized = sanitizeClaudeCodeAttribution(state.request.body);
        const changed = sanitized !== state.request.body;
        if (changed) {
          state.request = {
            ...state.request,
            body: sanitized,
            stream: bodyRequestsStreaming(sanitized),
          };
          tokenEstimate = null;
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail: changed ? "attribution stripped" : "no attribution found",
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "cache": {
        const key = apiProxyResponseCacheKey({
          namespace: node.config.namespace,
          modelId: input.request.modelId,
          body: state.request.body,
        });
        const alreadyOwned =
          input.ownedKeys?.has(key) ||
          state.responseEffects.some(
            (effect) => effect.type === "cache-store" && effect.key === key,
          );
        if (alreadyOwned) {
          state.routeTrace.push(
            nodeStep(pipeline, node, {
              port: "next",
              detail: "duplicate cache key (pass-through)",
            }),
          );
          ref = node.ports.next;
          break;
        }
        const cached = input.lookupCache ? await input.lookupCache(key) : null;

        if (state.request.stream) {
          if (cached && cached.isSse) {
            state.routeTrace.push(
              nodeStep(pipeline, node, { port: "hit", detail: "cache hit" }),
            );
            return {
              ok: true,
              kind: "response",
              source: "store",
              request: state.request,
              response: {
                status: cached.status,
                contentType: cached.contentType,
                body: cached.body,
              },
              cacheKey: key,
              textReplacementCount: state.textReplacementCount,
              responseEffects: state.responseEffects,
              routeTrace: state.routeTrace,
            };
          }
          const subscription = input.findBroadcast
            ? input.findBroadcast(key)
            : null;
          if (subscription) {
            state.routeTrace.push(
              nodeStep(pipeline, node, {
                port: "hit",
                detail: "stream fan-out",
              }),
            );
            return {
              ok: true,
              kind: "response",
              source: "coalesced",
              request: state.request,
              response: {
                status: 200,
                contentType: subscription.contentType,
                body: subscription.body,
              },
              cacheKey: key,
              textReplacementCount: state.textReplacementCount,
              responseEffects: state.responseEffects,
              routeTrace: state.routeTrace,
            };
          }
          if (input.registerBroadcast) {
            input.registerBroadcast(key);
          }
          state.responseEffects.push({
            type: "cache-store",
            key,
            ttlSeconds: node.config.ttlSeconds,
          });
          state.routeTrace.push(
            nodeStep(pipeline, node, {
              port: "next",
              detail: "stream cache miss (owner)",
            }),
          );
          ref = node.ports.next;
          break;
        }

        if (cached && !cached.isSse) {
          state.routeTrace.push(
            nodeStep(pipeline, node, { port: "hit", detail: "cache hit" }),
          );
          return {
            ok: true,
            kind: "response",
            source: "store",
            request: state.request,
            response: {
              status: cached.status,
              contentType: cached.contentType,
              body: cached.body,
            },
            cacheKey: key,
            textReplacementCount: state.textReplacementCount,
            responseEffects: state.responseEffects,
            routeTrace: state.routeTrace,
          };
        }
        const pending = input.findInFlight ? input.findInFlight(key) : null;
        if (pending) {
          const coalesced = await pending;
          if (coalesced) {
            state.routeTrace.push(
              nodeStep(pipeline, node, {
                port: "hit",
                detail: "cache coalesced",
              }),
            );
            return {
              ok: true,
              kind: "response",
              source: "coalesced",
              request: state.request,
              response: {
                status: coalesced.status,
                contentType: coalesced.contentType,
                body: coalesced.body,
              },
              cacheKey: key,
              textReplacementCount: state.textReplacementCount,
              responseEffects: state.responseEffects,
              routeTrace: state.routeTrace,
            };
          }
          state.responseEffects.push({
            type: "cache-store",
            key,
            ttlSeconds: node.config.ttlSeconds,
          });
          state.routeTrace.push(
            nodeStep(pipeline, node, {
              port: "next",
              detail: "cache miss (coalesce fallthrough)",
            }),
          );
          ref = node.ports.next;
          break;
        }
        if (input.registerOwner) {
          input.registerOwner(key);
        }
        state.responseEffects.push({
          type: "cache-store",
          key,
          ttlSeconds: node.config.ttlSeconds,
        });
        state.routeTrace.push(
          nodeStep(pipeline, node, { port: "next", detail: "cache miss" }),
        );
        ref = node.ports.next;
        break;
      }
      case "capture-request": {
        const details: string[] = [];
        if (node.config.request) {
          if (input.recordRequest) {
            await input.recordRequest({
              kind: "capture-request",
              nodeName: node.name || null,
              protocol: input.request.operation.protocol,
              endpoint: input.request.operation.endpoint,
              routePath: input.request.operation.routePath,
              modelId: input.request.modelId,
              requestBody: state.request.body,
            });
            details.push("request saved");
          } else {
            details.push("request (dry run)");
          }
        }
        if (node.config.response) {
          state.responseEffects.push({
            type: "capture-response",
            nodeName: node.name || null,
          });
          details.push("response at completion");
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: "next",
            detail:
              details.length > 0 ? details.join(" · ") : "nothing to save",
          }),
        );
        ref = node.ports.next;
        break;
      }
      case "condition": {
        const outcome = evaluateApiProxyCondition(node.config.predicate, {
          body: state.request.body,
          sourceId,
          estimateTokens,
        });
        if (!outcome.ok) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_route_invalid",
              `Condition node ${node.name || node.id} in pipeline ${pipeline.name} failed: ${outcome.error}`,
            ),
          );
        }
        const port = outcome.value ? "true" : "false";
        state.routeTrace.push(
          nodeStep(pipeline, node, { port, detail: outcome.detail }),
        );
        ref = outcome.value ? node.ports.true : node.ports.false;
        break;
      }
      case "call": {
        const callee = input.getPipeline(node.config.pipelineId);
        if (!callee) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_pipeline_not_found",
              `Call node ${node.name || node.id} in pipeline ${pipeline.name} points to missing pipeline ${node.config.pipelineId}.`,
            ),
          );
        }
        if (!callee.enabled) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_pipeline_disabled",
              `Call node ${node.name || node.id} in pipeline ${pipeline.name} points to disabled pipeline ${callee.name}.`,
            ),
          );
        }
        if (
          callee.id === pipeline.id ||
          callStack.some((frame) => frame.calleeId === callee.id)
        ) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_pipeline_cycle",
              `Call node ${node.name || node.id} in pipeline ${pipeline.name} calls pipeline ${callee.name} recursively.`,
            ),
          );
        }
        if (callStack.length >= maxCallDepth) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_pipeline_cycle",
              `Proxy route for model ${modelId} exceeded call depth ${maxCallDepth}.`,
            ),
          );
        }
        callStack.push({
          ownerPipeline: pipeline,
          node,
          calleeId: callee.id,
        });
        state.routeTrace.push(
          nodeStep(pipeline, node, { detail: `call ${callee.name}` }),
        );
        currentPipeline = callee;
        state.routeTrace.push(
          traceStep({
            kind: "enter-pipeline",
            pipelineId: callee.id,
            pipelineName: callee.name,
          }),
        );
        ref = callee.entry;
        break;
      }
      case "exit": {
        const exitName = node.config.exitName;
        const frame = callStack.pop();
        if (!frame) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_route_invalid",
              `Pipeline ${pipeline.name} exits via "${exitName}" without a calling pipeline (route for model ${modelId}).`,
            ),
          );
        }
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            port: exitName,
            detail: `return to ${frame.ownerPipeline.name}`,
          }),
        );
        const continuation = frame.node.ports[exitName];
        if (!continuation) {
          return fail(
            routeDiagnostic(
              503,
              "arriero_proxy_route_unbound",
              `Call node ${frame.node.name || frame.node.id} in pipeline ${frame.ownerPipeline.name} has no wiring for exit "${exitName}".`,
            ),
          );
        }
        currentPipeline = frame.ownerPipeline;
        ref = continuation;
        break;
      }
      case "fusion": {
        state.routeTrace.push(
          nodeStep(pipeline, node, {
            detail: `fusion (${node.ports.panel.length} panel)`,
          }),
        );
        return {
          ok: true,
          kind: "fusion",
          request: state.request,
          node,
          pipeline,
          textReplacementCount: state.textReplacementCount,
          responseEffects: state.responseEffects,
          routeTrace: state.routeTrace,
        };
      }
    }
  }
}
