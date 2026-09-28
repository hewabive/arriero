import {
  instanceIdFromEndpointId,
  type ApiProxyTargetRecord,
} from "@arriero/core";

import { listInstances } from "../instances/repository.js";
import { listMemoryPools } from "../resources/repository.js";
import {
  computeDomainCoordinator,
  type DomainLease,
} from "./domain-coordinator.js";
import { externalTargetEndpointId } from "./external-target.js";
import { apiProxyInflight } from "./inflight.js";
import type { ApiProxyProtocolDiagnostic } from "./protocol.js";
import { getApiProxyTarget, listApiProxyTargets } from "./repository.js";
import { computeDomains } from "./resource-domains.js";
import { serveTargetInstanceId } from "./serve-target-id.js";

export type ApiProxyRunReservation = {
  runId: string;
  label: string;
  instanceNames: string[];
  expectedEndAt: string | null;
};

export type ApiProxyReservationScope = {
  instanceNames: string[];
  targetNames: string[];
  domains: string[];
  drawsDeclared: boolean;
};

export type ApiProxyReservationHandle = {
  reservation: ApiProxyRunReservation;
  release: () => void;
};

export class ApiProxyReservationError extends Error {}

const POLL_MS = 200;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

const reservations = new Map<
  string,
  { reservation: ApiProxyRunReservation; lease: DomainLease | null }
>();

export function apiProxyTargetInstanceName(
  targetId: string,
  target: Pick<ApiProxyTargetRecord, "endpointId"> | null,
): string | null {
  if (target) {
    return instanceIdFromEndpointId(target.endpointId);
  }
  const servedInstanceId = serveTargetInstanceId(targetId);
  if (servedInstanceId !== null) {
    return servedInstanceId;
  }
  const endpointId = externalTargetEndpointId(targetId);
  return endpointId ? instanceIdFromEndpointId(endpointId) : null;
}

export function apiProxyReservationScope(
  instanceName: string,
): ApiProxyReservationScope {
  const instances = listInstances();
  const pools = listMemoryPools();
  const subject = instances.find((instance) => instance.name === instanceName);
  const domains = subject ? computeDomains(subject.memory, pools) : [];
  const names = new Set([instanceName]);
  if (domains.length > 0) {
    for (const instance of instances) {
      const drawn = computeDomains(instance.memory, pools);
      if (drawn.some((domain) => domains.includes(domain))) {
        names.add(instance.name);
      }
    }
  }
  const instanceNames = [...names].sort();
  return {
    instanceNames,
    targetNames: listApiProxyTargets()
      .filter((target) => {
        const name = instanceIdFromEndpointId(target.endpointId);
        return name !== null && names.has(name);
      })
      .map((target) => target.name)
      .sort(),
    domains,
    drawsDeclared: domains.length > 0,
  };
}

export function apiProxyInstanceReservation(
  instanceName: string | null,
): ApiProxyRunReservation | null {
  if (instanceName === null) {
    return null;
  }
  for (const { reservation } of reservations.values()) {
    if (reservation.instanceNames.includes(instanceName)) {
      return reservation;
    }
  }
  return null;
}

export function reservedApiProxyInstanceNames(): Set<string> {
  const names = new Set<string>();
  for (const { reservation } of reservations.values()) {
    for (const name of reservation.instanceNames) {
      names.add(name);
    }
  }
  return names;
}

export function apiProxyTargetReservation(
  targetId: string,
  target: Pick<ApiProxyTargetRecord, "endpointId"> | null,
): ApiProxyRunReservation | null {
  return apiProxyInstanceReservation(
    apiProxyTargetInstanceName(targetId, target),
  );
}

export function apiProxyReservationDiagnostic(
  reservation: ApiProxyRunReservation,
  now = Date.now(),
): ApiProxyProtocolDiagnostic {
  const endMs = reservation.expectedEndAt
    ? Date.parse(reservation.expectedEndAt)
    : Number.NaN;
  const retryAfterSeconds = Number.isFinite(endMs)
    ? Math.max(1, Math.ceil((endMs - now) / 1000))
    : DEFAULT_RETRY_AFTER_SECONDS;
  const until = reservation.expectedEndAt
    ? ` until about ${reservation.expectedEndAt}`
    : "";
  return {
    status: 503,
    code: "arriero_proxy_instance_reserved",
    param: "model",
    message: `The instance behind this model is reserved by benchmark run "${reservation.label}"${until}; retry later.`,
    retryAfterSeconds,
  };
}

function activeReservedRequests(instanceNames: Set<string>): string[] {
  return [...apiProxyInflight.activeTargetIds()].filter((targetId) => {
    const name = apiProxyTargetInstanceName(
      targetId,
      getApiProxyTarget(targetId),
    );
    return name !== null && instanceNames.has(name);
  });
}

function waitFor<T>(
  probe: () => T | null,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const value = probe();
      if (value !== null) {
        resolve(value);
        return;
      }
      if (signal?.aborted || Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, POLL_MS);
    };
    check();
  });
}

export async function reserveApiProxyInstances(input: {
  runId: string;
  label: string;
  instanceName: string;
  expectedEndAt: string | null;
  drainTimeoutMs: number;
  signal?: AbortSignal | undefined;
}): Promise<ApiProxyReservationHandle> {
  const scope = apiProxyReservationScope(input.instanceName);
  const taken = scope.instanceNames.filter(
    (name) => apiProxyInstanceReservation(name) !== null,
  );
  if (taken.length > 0) {
    throw new ApiProxyReservationError(
      `instances already reserved by another run: ${taken.join(", ")}`,
    );
  }
  const reservation: ApiProxyRunReservation = {
    runId: input.runId,
    label: input.label,
    instanceNames: scope.instanceNames,
    expectedEndAt: input.expectedEndAt,
  };
  reservations.set(input.runId, { reservation, lease: null });
  const release = () => {
    reservations.get(input.runId)?.lease?.release();
    reservations.delete(input.runId);
  };
  const names = new Set(scope.instanceNames);
  const drained = await waitFor(
    () => (activeReservedRequests(names).length === 0 ? true : null),
    input.drainTimeoutMs,
    input.signal,
  );
  if (drained === null) {
    const active = activeReservedRequests(names);
    release();
    throw new ApiProxyReservationError(
      input.signal?.aborted
        ? "the reservation was canceled"
        : `proxy requests still running on the reserved instances: ${active.join(", ")}`,
    );
  }
  if (scope.domains.length > 0) {
    const lease = await waitFor(
      () => computeDomainCoordinator.tryAcquireMaintenance(scope.domains),
      input.drainTimeoutMs,
      input.signal,
    );
    if (lease === null) {
      release();
      throw new ApiProxyReservationError(
        "the resource pools of the instance stayed busy",
      );
    }
    const entry = reservations.get(input.runId);
    if (entry) {
      entry.lease = lease;
    } else {
      lease.release();
    }
  }
  return { reservation, release };
}
