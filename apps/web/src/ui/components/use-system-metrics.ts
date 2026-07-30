import {
  SYSTEM_METRICS_TIERS,
  type SystemMetricsSample,
  type SystemMetricsWindow,
} from "@arriero/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { getSystemMetrics, systemMetricsStreamUrl } from "../../api/client";

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
  const tier = SYSTEM_METRICS_TIERS[window];
  const query = useQuery({
    queryKey: ["system-metrics", window],
    queryFn: () => getSystemMetrics(window),
    refetchInterval: window === "live" ? false : tier.intervalMs,
  });
  const [live, setLive] = useState<SystemMetricsSample[]>([]);

  useEffect(() => {
    if (window !== "live") {
      setLive([]);
      return;
    }

    const limit = SYSTEM_METRICS_TIERS[window].capacity;
    const source = new EventSource(systemMetricsStreamUrl());
    const handler = (event: MessageEvent<string>) => {
      const sample = JSON.parse(event.data) as SystemMetricsSample;
      setLive((previous) => [...previous, sample].slice(-limit));
    };
    source.addEventListener("sample", handler as EventListener);

    return () => {
      source.removeEventListener("sample", handler as EventListener);
      source.close();
    };
  }, [window]);

  const capacity = query.data?.data.capacity ?? tier.capacity;
  const intervalMs = query.data?.data.intervalMs ?? tier.intervalMs;
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
