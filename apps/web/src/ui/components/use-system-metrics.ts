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
  const lastHistory = history[history.length - 1];
  const firstLive = live[0];
  if (!lastHistory || !firstLive || firstLive.at > lastHistory.at) {
    return [...history, ...live].slice(-capacity);
  }
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
    const handler = (event: MessageEvent<string>) => {
      const sample = JSON.parse(event.data) as SystemMetricsSample;
      setLive((previous) => {
        const last = previous[previous.length - 1];
        if (last && sample.at <= last.at) {
          return previous;
        }
        return [...previous, sample].slice(-limit);
      });
    };
    let source: EventSource | null = null;
    const open = () => {
      if (source) {
        return;
      }
      source = new EventSource(systemMetricsStreamUrl());
      source.addEventListener("sample", handler as EventListener);
    };
    const close = () => {
      if (!source) {
        return;
      }
      source.removeEventListener("sample", handler as EventListener);
      source.close();
      source = null;
    };
    const syncVisibility = () => {
      if (document.hidden) {
        close();
      } else {
        open();
      }
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);

    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      close();
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
