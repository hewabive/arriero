import {
  ApiProxyPlanPreviewSchema,
  type ApiProxyPlanPreview,
  type ApiProxySchedulerPlanRequest,
  type ApiProxyTargetRecord,
} from "@llama-manager/core";

import { config } from "../config.js";
import { getInstance } from "../instances/repository.js";
import { listMemoryPools } from "../resources/repository.js";
import { schedulerPoolInputs } from "../resources/ledger.js";
import {
  requestLlamaModelAction,
  requestLlamaSlotAction,
} from "../llama/probe.js";
import { supervisor } from "../process/supervisor.js";
import { computeDomainCoordinator } from "./domain-coordinator.js";
import { proxyEngineGates } from "./engine-capabilities.js";
import { apiProxyPendingResume } from "./pending-resume.js";
import { computeDomains } from "./resource-domains.js";
import { addApiProxySavedSlotId, apiProxySlotFilename } from "./repository.js";
import { getApiProxyRuntimeSnapshot } from "./runtime-snapshot.js";
import {
  planApiProxyIdleMaintenance,
  planApiProxyRequest,
} from "./scheduler.js";

export async function buildApiProxyPlanRequest(input: {
  mode: "request" | "idle";
  requestedTargetId?: string | undefined;
  preferredTargetId?: string | undefined;
  extraTarget?: ApiProxyTargetRecord | undefined;
  residency?: "cached" | "live" | undefined;
}): Promise<{
  request: ApiProxySchedulerPlanRequest;
  runtime: Awaited<ReturnType<typeof getApiProxyRuntimeSnapshot>>;
}> {
  const runtime = await getApiProxyRuntimeSnapshot({
    purpose: "scheduling",
    ...(input.extraTarget !== undefined
      ? { extraTarget: input.extraTarget }
      : {}),
    ...(input.residency !== undefined ? { residency: input.residency } : {}),
  });
  const runtimeByTargetId = new Map(
    runtime.snapshot.targets.map((target) => [target.targetId, target]),
  );
  const targets = runtime.targets.map((target) => {
    const targetRuntime = runtimeByTargetId.get(target.id);
    const instanceId = targetRuntime?.instanceId ?? null;
    const instance = instanceId ? (getInstance(instanceId) ?? null) : null;
    const draws = instance?.memory ?? [];
    const gates = proxyEngineGates(instance);
    const capabilities = {
      modelLoadUnload: gates.modelLoadUnload,
      slotSave: gates.slotSave,
    };
    return targetRuntime
      ? {
          ...target,
          instanceId,
          runtime: targetRuntime,
          draws,
          capabilities,
        }
      : { ...target, instanceId: null, draws, capabilities };
  });
  const targetInstanceIds = new Set(
    targets
      .map((target) => target.instanceId)
      .filter((id): id is string => Boolean(id)),
  );
  const request: ApiProxySchedulerPlanRequest = {
    mode: input.mode,
    now: runtime.snapshot.checkedAt,
    targets,
    pools: schedulerPoolInputs(targetInstanceIds),
    protectedTargetIds: [...computeDomainCoordinator.wantedTargetIds()],
    pinnedTargetIds: apiProxyPendingResume.targetIds(),
  };
  if (input.requestedTargetId) {
    request.requestedTargetId = input.requestedTargetId;
  }
  if (input.preferredTargetId) {
    request.preferredTargetId = input.preferredTargetId;
  }
  return { request, runtime };
}

export async function buildApiProxyPlanContext(input: {
  mode: "request" | "idle";
  requestedTargetId?: string | undefined;
  preferredTargetId?: string | undefined;
  extraTarget?: ApiProxyTargetRecord | undefined;
  residency?: "cached" | "live" | undefined;
}): Promise<{
  request: ApiProxySchedulerPlanRequest;
  runtime: Awaited<ReturnType<typeof getApiProxyRuntimeSnapshot>>;
  preview: ApiProxyPlanPreview;
}> {
  const { request, runtime } = await buildApiProxyPlanRequest(input);
  const plan =
    input.mode === "request"
      ? planApiProxyRequest(request)
      : planApiProxyIdleMaintenance(request);

  const preview = ApiProxyPlanPreviewSchema.parse({
    checkedAt: runtime.snapshot.checkedAt,
    runtime: runtime.snapshot,
    plan,
  });
  return { request, runtime, preview };
}

export async function getApiProxyPlanPreview(input: {
  mode: "request" | "idle";
  requestedTargetId?: string | undefined;
  preferredTargetId?: string | undefined;
  extraTarget?: ApiProxyTargetRecord | undefined;
  residency?: "cached" | "live" | undefined;
}) {
  return (await buildApiProxyPlanContext(input)).preview;
}

async function runApiProxyIdleMaintenancePass() {
  apiProxyPendingResume.sweep();
  const preview = await getApiProxyPlanPreview({ mode: "idle" });
  const actionsByTarget = new Map<
    string,
    (typeof preview.plan.actions)[number][]
  >();
  for (const action of preview.plan.actions) {
    if (
      action.type !== "save-slot" &&
      action.type !== "unload-model" &&
      action.type !== "stop-instance"
    ) {
      continue;
    }
    const bucket = actionsByTarget.get(action.targetId);
    if (bucket) {
      bucket.push(action);
    } else {
      actionsByTarget.set(action.targetId, [action]);
    }
  }
  if (actionsByTarget.size === 0) {
    return;
  }

  const pools = listMemoryPools();
  for (const [, actions] of actionsByTarget) {
    const instanceId = actions[0]?.instanceId ?? null;
    const instance = instanceId ? getInstance(instanceId) : null;
    if (!instance) {
      continue;
    }
    const domains = computeDomains(instance.memory, pools);
    const lease =
      domains.length > 0
        ? computeDomainCoordinator.tryAcquireMaintenance(domains)
        : null;
    if (domains.length > 0 && !lease) {
      continue;
    }
    try {
      for (const action of actions) {
        if (action.type === "save-slot" && action.slotId !== null) {
          await requestLlamaSlotAction(instance, "save", action.slotId, {
            filename: apiProxySlotFilename(action.targetId, action.slotId),
          });
          addApiProxySavedSlotId(action.targetId, action.slotId);
        } else if (action.type === "unload-model" && action.model) {
          await requestLlamaModelAction(instance, "unload", action.model);
        } else if (action.type === "stop-instance") {
          supervisor.stop(instance.name);
        }
      }
    } finally {
      lease?.release();
    }
  }
}

export function startApiProxyIdleMaintenanceLoop(options?: {
  intervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): () => void {
  const intervalMs =
    options?.intervalMs ?? config.proxy.idleMaintenanceIntervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined;
  }

  let running = false;
  const tick = () => {
    if (running) {
      return;
    }
    running = true;
    void runApiProxyIdleMaintenancePass()
      .catch((error) => options?.onError?.(error))
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
