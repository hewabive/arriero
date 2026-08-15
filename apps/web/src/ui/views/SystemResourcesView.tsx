import type { SystemMetricsWindow } from "@arriero/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getEventLoopReport, getSystemResources } from "../../api/client";
import { SystemResourcesPanel } from "../components/SystemResourcesPanel";
import { useSystemMetrics } from "../components/use-system-metrics";

export function SystemResourcesView() {
  const [window, setWindow] = useState<SystemMetricsWindow>("live");
  const resourcesQuery = useQuery({
    queryKey: ["system-resources"],
    queryFn: getSystemResources,
    refetchInterval: 2_000,
  });
  const eventLoopQuery = useQuery({
    queryKey: ["system-event-loop"],
    queryFn: getEventLoopReport,
    refetchInterval: 10_000,
  });
  const metrics = useSystemMetrics(window);

  return (
    <SystemResourcesPanel
      resources={resourcesQuery.data?.data}
      eventLoop={eventLoopQuery.data?.data}
      samples={metrics.samples}
      windowMs={metrics.windowMs}
      intervalMs={metrics.intervalMs}
      window={window}
      onWindowChange={setWindow}
      fetching={resourcesQuery.isFetching}
    />
  );
}
