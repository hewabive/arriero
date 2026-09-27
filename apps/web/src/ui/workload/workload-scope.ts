import type { ApiProxyTraceFacet, WorkloadTimeRange } from "@arriero/core";

export type WorkloadPeriod = "6h" | "24h" | "7d" | "30d";

export type WorkloadScopeState = {
  period: WorkloadPeriod;
  sourceId: string | null;
  modelId: string | null;
};

export const defaultWorkloadScope: WorkloadScopeState = {
  period: "24h",
  sourceId: null,
  modelId: null,
};

const HOUR_MS = 60 * 60 * 1000;

const PERIOD_SPAN_MS: Record<WorkloadPeriod, number> = {
  "6h": 6 * HOUR_MS,
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};

export const WORKLOAD_PERIOD_OPTIONS: Array<{
  value: WorkloadPeriod;
  label: string;
}> = [
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export function isWorkloadPeriod(value: string): value is WorkloadPeriod {
  return value in PERIOD_SPAN_MS;
}

export function workloadPeriodRange(
  period: WorkloadPeriod,
  now: number,
): WorkloadTimeRange {
  return {
    from: new Date(now - PERIOD_SPAN_MS[period]).toISOString(),
    to: new Date(now).toISOString(),
  };
}

const MAX_WINDOWS = 1500;

export const WORKLOAD_WINDOW_OPTIONS = [
  { value: "15", label: "15 min windows" },
  { value: "30", label: "30 min windows" },
  { value: "60", label: "1 h windows" },
  { value: "360", label: "6 h windows" },
];

const NICE_STEP_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

export function workloadStepMinutes(
  period: WorkloadPeriod,
  windowMinutes: number,
): number {
  const needed = Math.max(
    windowMinutes / 3,
    PERIOD_SPAN_MS[period] / 60_000 / MAX_WINDOWS,
  );
  return (
    NICE_STEP_MINUTES.find((step) => step >= needed) ??
    NICE_STEP_MINUTES[NICE_STEP_MINUTES.length - 1] ??
    1440
  );
}

export function facetSelectData(
  entries: ApiProxyTraceFacet[] | undefined,
): Array<{ value: string; label: string }> {
  return (entries ?? []).map((entry) => ({
    value: entry.value,
    label: entry.name ?? entry.value,
  }));
}
