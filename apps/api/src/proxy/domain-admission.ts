import type {
  ApiProxySchedulerPlanRequest,
  ApiProxyTargetPlanInput,
  Instance,
} from "@arriero/core";
import { engineDescriptor } from "@arriero/core";

import type {
  DomainAdmissionContext,
  DomainAdmissionDecision,
  DomainHolderView,
} from "./domain-coordinator.js";
import { planApiProxyRequest } from "./scheduler.js";

function overlayHolderState(
  target: ApiProxyTargetPlanInput,
  holder: DomainHolderView,
): ApiProxyTargetPlanInput {
  if (!target.runtime) {
    return target;
  }
  if (holder.running) {
    return {
      ...target,
      runtime: {
        ...target.runtime,
        state: "ready",
        activeRequests: Math.max(1, target.runtime.activeRequests),
      },
    };
  }
  return {
    ...target,
    runtime: { ...target.runtime, state: "unloaded", activeRequests: 0 },
  };
}

function positiveIntegerArg(
  args: Instance["args"],
  keys: string[],
): number | undefined {
  const raw = keys.map((key) => args[key]).find((value) => value !== undefined);
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const CONCURRENCY_KEYS = {
  "llama-parallel": ["--parallel", "-np"],
  "vllm-sequences": ["--max-num-seqs"],
  "sglang-max-running-requests": ["--max-running-requests"],
  none: [],
} as const;

export function parseInstanceConcurrencyLimit(
  instance: Pick<Instance, "kind" | "args">,
): number | undefined {
  return positiveIntegerArg(instance.args, [
    ...CONCURRENCY_KEYS[engineDescriptor(instance.kind).concurrency],
  ]);
}

/** @deprecated Use the descriptor-driven parseInstanceConcurrencyLimit. */
export function parseInstanceParallelLimit(
  args: Instance["args"],
): number | undefined {
  return positiveIntegerArg(args, ["--parallel", "-np"]);
}

export function buildDomainAdmissionDecider(input: {
  candidateTargetId: string;
  candidatePriority: number;
  planRequest: ApiProxySchedulerPlanRequest;
  parallelLimit?: number | undefined;
}): (context: DomainAdmissionContext) => DomainAdmissionDecision {
  const { candidateTargetId, candidatePriority, planRequest, parallelLimit } =
    input;

  return (context) => {
    if (parallelLimit !== undefined) {
      const sameTargetHolders = context.holders.filter(
        (holder) => holder.running && holder.targetId === candidateTargetId,
      ).length;
      if (sameTargetHolders >= parallelLimit) {
        return { type: "wait" };
      }
    }

    if (
      context.holders.some(
        (holder) => holder.running && holder.priority > candidatePriority,
      )
    ) {
      return { type: "wait" };
    }

    const holderByTarget = new Map(
      context.holders.map((holder) => [holder.targetId, holder]),
    );
    const targets = planRequest.targets.map((target) => {
      if (target.id === candidateTargetId) {
        return target;
      }
      const holder = holderByTarget.get(target.id);
      return holder ? overlayHolderState(target, holder) : target;
    });

    const plan = planApiProxyRequest(
      { ...planRequest, targets, requestedTargetId: candidateTargetId },
      { allowBusyEviction: true },
    );

    if (!plan.ok) {
      return { type: "wait" };
    }
    if (plan.preemptTargetIds.length === 0) {
      return { type: "admit" };
    }

    const leaseIds = context.holders
      .filter(
        (holder) =>
          holder.running && plan.preemptTargetIds.includes(holder.targetId),
      )
      .map((holder) => holder.leaseId);
    if (leaseIds.length === 0) {
      return { type: "wait" };
    }
    return { type: "preempt", leaseIds };
  };
}
