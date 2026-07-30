import type { SystemMetricsSample, SystemMetricsWindow } from "@arriero/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { getSystemMetrics, systemMetricsStreamUrl } from "../../api/client";

const COARSE_REFETCH_MS: Record<SystemMetricsWindow, number | false> = {
  live: false,
  hour: 10_000,
  day: 60_000,
};

function mergeSamples(
  history: SystemMetricsSample[],
  live: SystemMetricsSample[],
  capacity: number,
): SystemMetricsSample[] {
  const byTime = new Map<number, SystemMetricsSample>();
  for (const sample of history) {
    byTime.set(sample.at, sample);
  }
  for (const sample of live) {
    byTime.set(sample.at, sample);
  }
  return [...byTime.values()]
    .sort((left, right) => left.at - right.at)
    .slice(-capacity);
}

export function useSystemMetrics(window: SystemMetricsWindow) {
  const query = useQuery({
    queryKey: ["system-metrics", window],
    queryFn: () => getSystemMetrics(window),
    refetchInterval: COARSE_REFETCH_MS[window],
  });
  const [live, setLive] = useState<SystemMetricsSample[]>([]);

  useEffect(() => {
    if (window !== "live") {
      setLive([]);
      return;
    }

    const source = new EventSource(systemMetricsStreamUrl());
    const handler = (event: MessageEvent<string>) => {
      const sample = JSON.parse(event.data) as SystemMetricsSample;
      setLive((previous) => [...previous.slice(-600), sample]);
    };
    source.addEventListener("sample", handler as EventListener);

    return () => {
      source.removeEventListener("sample", handler as EventListener);
      source.close();
    };
  }, [window]);

  const capacity = query.data?.data.capacity ?? 300;
  const intervalMs = query.data?.data.intervalMs ?? 1_000;
  const samples = useMemo(
    () => mergeSamples(query.data?.data.samples ?? [], live, capacity),
    [query.data, live, capacity],
  );

  return {
    samples,
    intervalMs,
    capacity,
    windowMs: intervalMs * capacity,
    loading: query.isLoading,
    error: query.error,
  };
}
