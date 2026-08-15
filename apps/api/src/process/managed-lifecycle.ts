import type {
  Instance,
  InstanceBulkActionName,
  ProcessPreflightIssue,
  RuntimeState,
} from "@arriero/core";

import { listInstances } from "../instances/repository.js";
import { admitInstanceDraw } from "../resources/ledger.js";
import { getInstanceHealthSummary } from "./health-summary.js";
import {
  ProcessPreflightError,
  validateInstancePreflight,
  validateInstanceStartPreflight,
} from "./preflight.js";
import { referencingOrchestrators } from "./rpc-preflight.js";
import { resolveRpcArgs } from "./rpc-launch.js";
import type { ProcessStopReason } from "./runs-repository.js";
import { liveStaleProcessRun, stopStaleProcess } from "./stale.js";
import { supervisor } from "./supervisor.js";

function assertWorkerNotReferenced(instance: Instance, force: boolean): void {
  if (force || instance.kind !== "rpc-worker") {
    return;
  }
  const holders = referencingOrchestrators(instance.name, listInstances());
  if (holders.length === 0) {
    return;
  }
  const list = holders.map((name) => `"${name}"`).join(", ");
  throw new ProcessActionHttpError(
    `rpc worker "${instance.name}" is in use by running orchestrator${holders.length > 1 ? "s" : ""} ${list}; stop ${holders.length > 1 ? "them" : "it"} first or force-stop to break the RPC link`,
    409,
  );
}

async function resolveRpcArgsOrThrow(instance: Instance): Promise<string[]> {
  try {
    return await resolveRpcArgs(instance);
  } catch (error) {
    throw new ProcessActionHttpError((error as Error).message, 400);
  }
}

function staleProcessConflict(instanceId: string) {
  const stale = liveStaleProcessRun(instanceId);
  if (stale) {
    return `instance has unmanaged stale process pid=${stale.pid}; stop it before starting another`;
  }
  return null;
}

export class ProcessActionHttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly issues: ProcessPreflightIssue[] = [],
  ) {
    super(message);
    this.name = "ProcessActionHttpError";
  }
}

export function actionAllowed(
  action: InstanceBulkActionName,
  health: Awaited<ReturnType<typeof getInstanceHealthSummary>>,
) {
  if (action === "start") return health.actions.canStart;
  if (action === "stop") return health.actions.canStop;
  return health.actions.canRestart;
}

export function skippedActionMessage(
  action: InstanceBulkActionName,
  health: Awaited<ReturnType<typeof getInstanceHealthSummary>>,
) {
  if (!health.preflight.ok && (action === "start" || action === "restart")) {
    const error = health.preflight.issues.find(
      (issue) => issue.level === "error",
    );
    return error?.message ?? "preflight must pass before starting";
  }
  if (health.status === "stale" && action !== "stop") {
    return "stale process must be stopped before starting another";
  }
  if (action === "start") return "instance is not startable";
  if (action === "stop") return "instance is not running";
  return "instance is not restartable";
}

export function actionErrorPayload(error: unknown): {
  error: string;
  issues: ProcessPreflightIssue[];
  status: 400 | 404 | 409;
} {
  if (error instanceof ProcessPreflightError) {
    return {
      error: error.message || "preflight failed",
      issues: error.result.issues,
      status: 400,
    };
  }
  if (error instanceof ProcessActionHttpError) {
    return {
      error: error.message,
      issues: error.issues,
      status: error.status,
    };
  }
  return {
    error: (error as Error).message,
    issues: [],
    status: 400,
  };
}

function issueMessage(issue: ProcessPreflightIssue) {
  return issue.field ? `${issue.field}: ${issue.message}` : issue.message;
}

export function actionErrorProxyMessage(error: unknown) {
  const payload = actionErrorPayload(error);
  const errors = payload.issues.filter((issue) => issue.level === "error");
  const issues = errors.length > 0 ? errors : payload.issues;
  if (issues.length === 0) {
    return payload.error;
  }
  return `${payload.error}: ${issues.map(issueMessage).join("; ")}`;
}

export async function startManagedInstance(
  instance: Instance,
): Promise<RuntimeState> {
  const staleConflict = staleProcessConflict(instance.name);
  if (staleConflict) {
    throw new ProcessActionHttpError(staleConflict, 409);
  }
  const preflight = await validateInstanceStartPreflight(instance, {
    peers: listInstances(),
    capacityAdmission: admitInstanceDraw(instance.memory, {
      excludeInstanceId: instance.name,
    }),
  });
  if (!preflight.ok) {
    throw new ProcessActionHttpError("preflight failed", 400, preflight.issues);
  }
  const rpcArgs = await resolveRpcArgsOrThrow(instance);
  return supervisor.start(instance, rpcArgs);
}

export async function startOrRecoverManagedInstance(
  instance: Instance,
): Promise<RuntimeState> {
  if (liveStaleProcessRun(instance.name)) {
    return restartManagedInstance(instance);
  }
  return startManagedInstance(instance);
}

export async function stopManagedInstance(
  instanceId: string,
  options: { force?: boolean; reason: ProcessStopReason },
): Promise<RuntimeState> {
  const instance = listInstances().find((item) => item.name === instanceId);
  if (instance) {
    assertWorkerNotReferenced(instance, options.force ?? false);
  }
  const state = supervisor.stop(instanceId, options.reason);
  if (state) {
    return state;
  }

  const staleState = await stopStaleProcess(instanceId, options.reason);
  if (staleState) {
    return staleState;
  }

  throw new ProcessActionHttpError("instance is not running", 404);
}

export async function restartManagedInstance(
  instance: Instance,
  options: { force?: boolean } = {},
): Promise<RuntimeState> {
  assertWorkerNotReferenced(instance, options.force ?? false);
  const preflight = await validateInstancePreflight(instance, {
    peers: listInstances(),
    capacityAdmission: admitInstanceDraw(instance.memory, {
      excludeInstanceId: instance.name,
    }),
  });
  if (!preflight.ok) {
    throw new ProcessActionHttpError("preflight failed", 400, preflight.issues);
  }
  const rpcArgs = await resolveRpcArgsOrThrow(instance);

  const staleState = await stopStaleProcess(instance.name, "stale");
  if (staleState) {
    const startPreflight = await validateInstanceStartPreflight(instance, {
      peers: listInstances(),
      capacityAdmission: admitInstanceDraw(instance.memory, {
        excludeInstanceId: instance.name,
      }),
    });
    if (!startPreflight.ok) {
      throw new ProcessActionHttpError(
        "preflight failed",
        400,
        startPreflight.issues,
      );
    }
    return supervisor.start(instance, rpcArgs);
  }

  return supervisor.restart(instance, rpcArgs, "operator");
}

export async function runInstanceAction(
  instance: Instance,
  action: InstanceBulkActionName,
) {
  if (action === "start") return startManagedInstance(instance);
  if (action === "stop")
    return stopManagedInstance(instance.name, { reason: "operator" });
  return restartManagedInstance(instance);
}
