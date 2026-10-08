import { observeBodyCompletion } from "./body-completion.js";
import { newId } from "../utils/id.js";

export type DomainHolderView = {
  leaseId: string;
  targetId: string;
  priority: number;
  preemptible: boolean;
  running: boolean;
};

export type DomainAdmissionContext = {
  domains: string[];
  holders: DomainHolderView[];
};

export type DomainAdmissionDecision =
  | { type: "admit" }
  | { type: "preempt"; leaseIds: string[] }
  | { type: "wait" };

export type DomainLeaseRequest = {
  domains: string[];
  targetId: string;
  priority: number;
  preemptible: boolean;
  continuation?: boolean | undefined;
  decide: (context: DomainAdmissionContext) => DomainAdmissionDecision;
  signal?: AbortSignal | undefined;
};

export type DomainLease = {
  id: string;
  targetId: string;
  priority: number;
  domains: string[];
  readonly preemptSignal: AbortSignal;
  yield(): Promise<void>;
  release(): void;
};

export class ResourceLeaseAbortedError extends Error {
  constructor(readonly leaseId: string) {
    super(`resource lease ${leaseId} was aborted before admission`);
    this.name = "ResourceLeaseAbortedError";
  }
}

const MAINTENANCE_TARGET = "__maintenance__";

const SWAP_FAIRNESS_MS = 2000;

const CONTINUATION_FAIRNESS_MS = 10_000;

type DomainLeaseStatus = "waiting" | "holding" | "suspended" | "settled";

type InternalDomainLease = {
  id: string;
  targetId: string;
  priority: number;
  preemptible: boolean;
  continuation: boolean;
  domains: string[];
  decide: (context: DomainAdmissionContext) => DomainAdmissionDecision;
  seq: number;
  enqueuedAt: number;
  status: DomainLeaseStatus;
  preemptController: AbortController;
  preemptFired: boolean;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  admit: (() => void) | null;
  fail: ((error: Error) => void) | null;
  lease: DomainLease;
};

function domainsOverlap(left: string[], right: string[]): boolean {
  return left.some((domain) => right.includes(domain));
}

export class ComputeDomainCoordinator {
  private holders: InternalDomainLease[] = [];
  private waiters: InternalDomainLease[] = [];
  private seq = 0;

  constructor(
    private readonly swapFairnessMs: number = SWAP_FAIRNESS_MS,
    private readonly continuationFairnessMs: number = CONTINUATION_FAIRNESS_MS,
  ) {}

  acquire(request: DomainLeaseRequest): Promise<DomainLease> {
    const internal = this.createLease(request);
    this.waiters.push(internal);

    const promise = new Promise<DomainLease>((resolve, reject) => {
      internal.admit = () => resolve(internal.lease);
      internal.fail = (error) => reject(error);
    });

    this.wireAbort(internal);
    this.scheduleAdmission();
    return promise;
  }

  busyTargetIds(): Set<string> {
    const ids = new Set<string>();
    for (const holder of this.holders) {
      if (
        holder.status === "holding" &&
        holder.targetId !== MAINTENANCE_TARGET
      ) {
        ids.add(holder.targetId);
      }
    }
    return ids;
  }

  wantedTargetIds(): Set<string> {
    const ids = new Set<string>();
    for (const lease of [...this.holders, ...this.waiters]) {
      if (lease.targetId !== MAINTENANCE_TARGET) {
        ids.add(lease.targetId);
      }
    }
    return ids;
  }

  tryAcquireMaintenance(domains: string[]): DomainLease | null {
    const occupied = [...this.holders, ...this.waiters].some((lease) =>
      domainsOverlap(lease.domains, domains),
    );
    if (occupied) {
      return null;
    }
    const internal = this.createLease({
      domains,
      targetId: MAINTENANCE_TARGET,
      priority: 0,
      preemptible: false,
      decide: () => ({ type: "wait" }),
    });
    internal.status = "holding";
    this.holders.push(internal);
    return internal.lease;
  }

  private createLease(request: DomainLeaseRequest): InternalDomainLease {
    const internal: InternalDomainLease = {
      id: newId(),
      targetId: request.targetId,
      priority: request.priority,
      preemptible: request.preemptible,
      continuation: request.continuation ?? false,
      domains: [...request.domains],
      decide: request.decide,
      seq: this.seq++,
      enqueuedAt: Date.now(),
      status: "waiting",
      preemptController: new AbortController(),
      preemptFired: false,
      signal: request.signal,
      onAbort: undefined,
      admit: null,
      fail: null,
      lease: undefined as unknown as DomainLease,
    };
    internal.lease = this.makeLease(internal);
    return internal;
  }

  private makeLease(internal: InternalDomainLease): DomainLease {
    return {
      id: internal.id,
      targetId: internal.targetId,
      priority: internal.priority,
      domains: internal.domains,
      get preemptSignal() {
        return internal.preemptController.signal;
      },
      yield: () => this.yieldLease(internal),
      release: () => this.releaseLease(internal),
    };
  }

  private holdersOnDomains(domains: string[]): InternalDomainLease[] {
    return this.holders.filter((holder) =>
      domainsOverlap(holder.domains, domains),
    );
  }

  private scheduleAdmission() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const now = Date.now();
      const isAffine = (lease: InternalDomainLease) =>
        this.holders.some(
          (holder) =>
            holder.status === "holding" &&
            holder.targetId !== MAINTENANCE_TARGET &&
            holder.targetId === lease.targetId &&
            domainsOverlap(holder.domains, lease.domains),
        );
      const pending = this.waiters.filter(
        (lease) => lease.status === "waiting" || lease.status === "suspended",
      );
      const starvedSwapWaiting = pending.some(
        (lease) =>
          !isAffine(lease) && now - lease.enqueuedAt >= this.swapFairnessMs,
      );
      const starvedFreshWaiting = pending.some(
        (lease) =>
          !lease.continuation &&
          now - lease.enqueuedAt >= this.continuationFairnessMs,
      );
      const candidates = pending.sort(
        (left, right) =>
          right.priority - left.priority ||
          (starvedSwapWaiting
            ? 0
            : Number(isAffine(right)) - Number(isAffine(left))) ||
          (starvedFreshWaiting
            ? 0
            : Number(right.continuation) - Number(left.continuation)) ||
          left.seq - right.seq,
      );

      for (const candidate of candidates) {
        const overlapping = this.holdersOnDomains(candidate.domains);
        if (
          overlapping.some((holder) => holder.targetId === MAINTENANCE_TARGET)
        ) {
          continue;
        }

        const decision = candidate.decide({
          domains: candidate.domains,
          holders: overlapping.map((holder) => ({
            leaseId: holder.id,
            targetId: holder.targetId,
            priority: holder.priority,
            preemptible: holder.preemptible,
            running: holder.status === "holding",
          })),
        });

        if (decision.type === "admit") {
          this.promote(candidate);
          progressed = true;
          break;
        }
        if (decision.type === "preempt") {
          this.firePreemptions(overlapping, decision.leaseIds);
        }
      }
    }
  }

  private firePreemptions(
    overlapping: InternalDomainLease[],
    leaseIds: string[],
  ) {
    const requested = new Set(leaseIds);
    for (const holder of overlapping) {
      if (
        requested.has(holder.id) &&
        holder.status === "holding" &&
        holder.preemptible &&
        holder.targetId !== MAINTENANCE_TARGET &&
        !holder.preemptFired &&
        !holder.preemptController.signal.aborted
      ) {
        holder.preemptFired = true;
        holder.preemptController.abort();
      }
    }
  }

  private promote(internal: InternalDomainLease) {
    this.waiters = this.waiters.filter((lease) => lease !== internal);
    this.holders.push(internal);
    internal.status = "holding";
    internal.preemptController = new AbortController();
    internal.preemptFired = false;

    const admit = internal.admit;
    internal.admit = null;
    internal.fail = null;
    admit?.();
  }

  private yieldLease(internal: InternalDomainLease): Promise<void> {
    if (!this.holders.includes(internal)) {
      return Promise.reject(
        new Error(`lease ${internal.id} called yield without holding`),
      );
    }

    this.holders = this.holders.filter((lease) => lease !== internal);
    internal.status = "suspended";
    this.waiters.push(internal);

    const promise = new Promise<void>((resolve, reject) => {
      internal.admit = () => resolve();
      internal.fail = (error) => reject(error);
    });

    this.scheduleAdmission();
    return promise;
  }

  private releaseLease(internal: InternalDomainLease) {
    if (internal.status === "settled") {
      return;
    }
    internal.status = "settled";
    this.holders = this.holders.filter((lease) => lease !== internal);
    this.waiters = this.waiters.filter((lease) => lease !== internal);
    this.detachAbort(internal);
    this.scheduleAdmission();
  }

  private wireAbort(internal: InternalDomainLease) {
    const signal = internal.signal;
    if (!signal) {
      return;
    }
    const onAbort = () => this.abortLease(internal);
    internal.onAbort = onAbort;
    if (signal.aborted) {
      queueMicrotask(onAbort);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private detachAbort(internal: InternalDomainLease) {
    if (internal.signal && internal.onAbort) {
      internal.signal.removeEventListener("abort", internal.onAbort);
    }
    internal.onAbort = undefined;
  }

  private abortLease(internal: InternalDomainLease) {
    if (internal.status === "settled") {
      return;
    }
    if (internal.status === "holding") {
      this.releaseLease(internal);
      return;
    }

    internal.status = "settled";
    this.waiters = this.waiters.filter((lease) => lease !== internal);
    const fail = internal.fail;
    internal.admit = null;
    internal.fail = null;
    this.detachAbort(internal);
    fail?.(new ResourceLeaseAbortedError(internal.id));
    this.scheduleAdmission();
  }
}

export const computeDomainCoordinator = new ComputeDomainCoordinator();

export function attachLeaseRelease(
  response: Response,
  lease: { release(): void },
): Response {
  if (!response.body) {
    lease.release();
    return response;
  }

  const stream = observeBodyCompletion(response.body, () => lease.release());

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
