import {
  engineDescriptor,
  type ApiEndpointRecord,
  type Instance,
  type InstanceEvictionPolicy,
} from "@arriero/core";

export type TargetEvictionContext =
  | {
      kind: "managed";
      instanceId: string;
      instancePolicy: InstanceEvictionPolicy;
    }
  | { kind: "managed-unavailable"; instanceId: string }
  | { kind: "not-managed" }
  | { kind: "unresolved" };

type EffectiveTargetEviction = {
  color: string;
  detail: string;
  label: string;
};

function instanceEvictionPolicy(instance: Instance): InstanceEvictionPolicy {
  return (
    instance.scheduling?.evictionPolicy ??
    engineDescriptor(instance.kind).defaultEvictionPolicy
  );
}

export function resolveTargetEvictionContext(
  endpoint: ApiEndpointRecord | undefined,
  instancesById: ReadonlyMap<string, Instance>,
): TargetEvictionContext {
  if (!endpoint) {
    return { kind: "unresolved" };
  }
  if (endpoint.kind !== "managed-instance") {
    return { kind: "not-managed" };
  }
  if (!endpoint.instanceId) {
    return { kind: "unresolved" };
  }
  const instance = endpoint.nodeId
    ? undefined
    : instancesById.get(endpoint.instanceId);
  if (!instance) {
    return {
      kind: "managed-unavailable",
      instanceId: endpoint.instanceId,
    };
  }
  return {
    kind: "managed",
    instanceId: instance.name,
    instancePolicy: instanceEvictionPolicy(instance),
  };
}

export function instanceEvictionLimitLabel(
  context: TargetEvictionContext,
): string {
  if (context.kind === "managed") {
    switch (context.instancePolicy) {
      case "never":
        return "Never";
      case "idle-only":
        return "Idle only";
      case "preemptible":
        return "Active requests may be interrupted";
    }
  }
  if (context.kind === "managed-unavailable") {
    return "Unavailable from this node";
  }
  if (context.kind === "not-managed") {
    return "Not managed by Arriero";
  }
  return "Select a managed endpoint";
}

export function effectiveTargetEviction(
  targetAllowsEviction: boolean,
  context: TargetEvictionContext,
): EffectiveTargetEviction {
  if (context.kind === "not-managed") {
    return {
      color: "gray",
      label: "Not applicable",
      detail:
        "This endpoint is not a managed instance, so Arriero cannot evict it for a competing request.",
    };
  }
  if (!targetAllowsEviction) {
    return {
      color: "gray",
      label: "Protected by target",
      detail:
        "This target blocks eviction by competing proxy requests, regardless of the instance limit. Its own idle-unload timer remains separate.",
    };
  }
  if (context.kind === "managed-unavailable") {
    return {
      color: "yellow",
      label: "Instance limit unknown",
      detail: `This target permits eviction, but the policy for remote instance ${context.instanceId} is unavailable from this node.`,
    };
  }
  if (context.kind === "unresolved") {
    return {
      color: "yellow",
      label: "Policy unresolved",
      detail: "Select a managed endpoint to see the effective eviction policy.",
    };
  }
  if (context.instancePolicy === "never") {
    return {
      color: "gray",
      label: "Protected by instance",
      detail:
        "This target permits eviction, but the instance limit prevents eviction by competing requests.",
    };
  }
  if (context.instancePolicy === "idle-only") {
    return {
      color: "blue",
      label: "Idle only",
      detail:
        "This target permits eviction. Active requests drain and keep live streaming; competing requests may evict the instance after it becomes idle.",
    };
  }
  return {
    color: "orange",
    label: "Interruptible",
    detail:
      "This target permits eviction and the instance allows a higher-priority competing request to interrupt active work. Resumable generation endpoints may buffer their response.",
  };
}
