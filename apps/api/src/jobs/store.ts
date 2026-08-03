export type BackgroundJobStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type BackgroundJobBase = {
  id: string;
  status: BackgroundJobStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

export type JobStore<J extends BackgroundJobBase> = {
  insert(job: J): J;
  patch(id: string, input: Partial<J>): J | null;
  get(id: string): J | null;
  list(limit?: number): J[];
  clear(): void;
};

export type LatestJobStore<J extends BackgroundJobBase> = {
  start(key: string, job: J): J;
  patch(key: string, input: Partial<J>): J | null;
  get(key: string): J | null;
  clear(): void;
};

export function createJobStore<J extends BackgroundJobBase>(options: {
  historyLimit: number;
}): JobStore<J> {
  const jobs = new Map<string, J>();

  const trim = () => {
    if (jobs.size <= options.historyLimit) {
      return;
    }
    const removable = [...jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const job of removable) {
      if (jobs.size <= options.historyLimit) {
        break;
      }
      jobs.delete(job.id);
    }
  };

  return {
    insert(job) {
      jobs.set(job.id, structuredClone(job));
      trim();
      return structuredClone(job);
    },
    patch(id, input) {
      const current = jobs.get(id);
      if (!current) {
        return null;
      }
      const next = { ...current, ...input, id: current.id };
      jobs.set(id, structuredClone(next));
      return structuredClone(next);
    },
    get(id) {
      const job = jobs.get(id);
      return job ? structuredClone(job) : null;
    },
    list(limit = 20) {
      return [...jobs.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, Math.max(1, Math.min(limit, 100)))
        .map((job) => structuredClone(job));
    },
    clear() {
      jobs.clear();
    },
  };
}

export function createLatestJobStore<
  J extends BackgroundJobBase,
>(): LatestJobStore<J> {
  const jobs = new Map<string, J>();

  return {
    start(key, job) {
      jobs.set(key, structuredClone(job));
      return structuredClone(job);
    },
    patch(key, input) {
      const current = jobs.get(key);
      if (!current) {
        return null;
      }
      const next = { ...current, ...input, id: current.id };
      jobs.set(key, structuredClone(next));
      return structuredClone(next);
    },
    get(key) {
      const job = jobs.get(key);
      return job ? structuredClone(job) : null;
    },
    clear() {
      jobs.clear();
    },
  };
}
