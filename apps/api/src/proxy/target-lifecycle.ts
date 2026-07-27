import type { ApiProxyTargetRecord } from "@arriero/core";

import { getInstance } from "../instances/repository.js";
import { getInstanceHealthSummary } from "../process/health-summary.js";
import {
  llamaEndpointErrorMessage,
  requestLlamaModelAction,
  requestLlamaSlotAction,
} from "../llama/probe.js";
import {
  ProcessActionHttpError,
  actionErrorProxyMessage,
  startOrRecoverManagedInstance,
  stopManagedInstance,
} from "../process/managed-lifecycle.js";
import { domainSwapCoordinator } from "./domain-swap-coordinator.js";
import { getApiProxyPlanPreview } from "./idle-maintenance.js";
import {
  executeApiProxyPublicMvpPlan,
  type ApiProxyPublicExecutorResult,
} from "./public-executor.js";
import {
  addApiProxySavedSlotId,
  apiProxySlotFilename,
  removeApiProxySavedSlotId,
} from "./repository.js";

function requiresSwap(
  preview: Awaited<ReturnType<typeof getApiProxyPlanPreview>>,
): boolean {
  return (
    preview.plan.ok &&
    preview.plan.actions.some((action) => action.type !== "route-request")
  );
}

export function executeApiProxyTargetReadiness(
  target: ApiProxyTargetRecord,
  initialPreview: Awaited<ReturnType<typeof getApiProxyPlanPreview>>,
  domains: string[],
  extraTarget?: ApiProxyTargetRecord | undefined,
  signal?: AbortSignal | undefined,
): Promise<ApiProxyPublicExecutorResult> {
  const runWith = (preview: typeof initialPreview) =>
    runReadinessExecutor(target, preview, extraTarget, signal);

  if (domains.length === 0 || !requiresSwap(initialPreview)) {
    return runWith(initialPreview);
  }

  return domainSwapCoordinator.run(domains, async () => {
    const fresh = await getApiProxyPlanPreview({
      mode: "request",
      requestedTargetId: target.id,
      ...(extraTarget !== undefined ? { extraTarget } : {}),
    });
    return runWith(fresh);
  });
}

function runReadinessExecutor(
  target: ApiProxyTargetRecord,
  initialPreview: Awaited<ReturnType<typeof getApiProxyPlanPreview>>,
  extraTarget?: ApiProxyTargetRecord | undefined,
  signal?: AbortSignal | undefined,
): Promise<ApiProxyPublicExecutorResult> {
  return executeApiProxyPublicMvpPlan({
    target,
    initialPreview,
    ...(signal !== undefined ? { signal } : {}),
    getInstance,
    startInstance: async (instance) => {
      try {
        return await startOrRecoverManagedInstance(instance);
      } catch (error) {
        throw new Error(actionErrorProxyMessage(error));
      }
    },
    describeStartFailure: async (instance) =>
      (await getInstanceHealthSummary(instance)).reason,
    loadModel: async (instance, model) => {
      const result = await requestLlamaModelAction(instance, "load", model);
      if (!result.response.ok) {
        throw new Error(llamaEndpointErrorMessage(result.response));
      }
    },
    unloadModel: async (instance, model) => {
      const result = await requestLlamaModelAction(instance, "unload", model);
      if (!result.response.ok) {
        throw new Error(llamaEndpointErrorMessage(result.response));
      }
    },
    stopInstance: async (instance) => {
      try {
        await stopManagedInstance(instance.name);
      } catch (error) {
        if (error instanceof ProcessActionHttpError && error.status === 404) {
          return;
        }
        throw new Error(actionErrorProxyMessage(error));
      }
    },
    saveSlot: async (instance, slotId, targetId) => {
      const result = await requestLlamaSlotAction(instance, "save", slotId, {
        filename: apiProxySlotFilename(targetId, slotId),
      });
      if (!result.response.ok) {
        throw new Error(llamaEndpointErrorMessage(result.response));
      }
      addApiProxySavedSlotId(targetId, slotId);
    },
    restoreSlot: async (instance, slotId, targetId) => {
      const result = await requestLlamaSlotAction(instance, "restore", slotId, {
        filename: apiProxySlotFilename(targetId, slotId),
      });
      if (!result.response.ok) {
        throw new Error(llamaEndpointErrorMessage(result.response));
      }
      removeApiProxySavedSlotId(targetId, slotId);
    },
    onRestoreSlotFailed: (targetId, slotId) => {
      removeApiProxySavedSlotId(targetId, slotId);
    },
    getPlanPreview: (targetId) =>
      getApiProxyPlanPreview({
        mode: "request",
        requestedTargetId: targetId,
        ...(extraTarget !== undefined ? { extraTarget } : {}),
      }),
  });
}
