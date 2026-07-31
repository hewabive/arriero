import type { ApiProxyPlanPreview, ApiProxyTargetRecord } from "@arriero/core";

import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolModelRequest,
  ApiProxyProtocolResponse,
} from "./protocol.js";

export type ApiProxyProtocolGatewayDecision =
  | {
      ok: true;
      target: ApiProxyTargetRecord;
      preview: ApiProxyPlanPreview;
    }
  | {
      ok: false;
      response: ApiProxyProtocolResponse;
    };

function actionSummary(actions: ApiProxyPlanPreview["plan"]["actions"]) {
  return actions
    .slice(0, 6)
    .map((action) => `${action.type}:${action.targetId}`)
    .join(", ");
}

export async function prepareApiProxyProtocolGatewayRequest(input: {
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  getTarget: (targetId: string) => ApiProxyTargetRecord | null;
  getPlanPreview: (targetId: string) => Promise<ApiProxyPlanPreview>;
  allowReadinessActions?: boolean | undefined;
  targetIdOverride?: string | null | undefined;
}): Promise<ApiProxyProtocolGatewayDecision> {
  const targetId = input.targetIdOverride ?? input.request.model.targetId;
  if (!targetId) {
    return {
      ok: false,
      response: input.adapter.diagnosticError(input.request, {
        status: 503,
        code: "arriero_proxy_model_unbound",
        param: "model",
        message: `Model ${input.request.modelId} is published by arriero, but it is not bound to a proxy target.`,
      }),
    };
  }

  const target = input.getTarget(targetId);
  if (!target) {
    return {
      ok: false,
      response: input.adapter.diagnosticError(input.request, {
        status: 503,
        code: "arriero_proxy_target_not_found",
        param: "model",
        message: `Model ${input.request.modelId} is bound to missing proxy target ${targetId}.`,
      }),
    };
  }

  const preview = await input.getPlanPreview(target.id);
  if (!preview.plan.ok) {
    return {
      ok: false,
      response: input.adapter.diagnosticError(input.request, {
        status: 503,
        code: "arriero_proxy_plan_blocked",
        param: "model",
        message: `Cannot route model ${input.request.modelId}: ${
          preview.plan.blockingReason ?? "scheduler blocked the request"
        }.`,
      }),
    };
  }

  const readinessActions = preview.plan.actions.filter(
    (action) => action.type !== "route-request",
  );
  if (readinessActions.length > 0 && !input.allowReadinessActions) {
    return {
      ok: false,
      response: input.adapter.diagnosticError(input.request, {
        status: 503,
        code: "arriero_proxy_target_not_ready",
        param: "model",
        message: `Proxy target ${target.name} is not ready for model ${
          input.request.modelId
        }. Scheduler requires ${readinessActions.length} action(s): ${actionSummary(
          readinessActions,
        )}.`,
      }),
    };
  }

  return {
    ok: true,
    target,
    preview,
  };
}

export async function buildApiProxyProtocolGatewayResponse(input: {
  adapter: ApiProxyProtocolAdapter;
  request: ApiProxyProtocolModelRequest;
  getTarget: (targetId: string) => ApiProxyTargetRecord | null;
  getPlanPreview: (targetId: string) => Promise<ApiProxyPlanPreview>;
}): Promise<ApiProxyProtocolResponse> {
  const decision = await prepareApiProxyProtocolGatewayRequest(input);
  if (!decision.ok) {
    return decision.response;
  }

  return input.adapter.notImplemented(input.request);
}
