import type { SystemMetricsWindow } from "@arriero/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getSystemResources } from "../../api/client";
import { SystemResourcesPanel } from "../components/SystemResourcesPanel";
import { useSystemMetrics } from "../components/use-system-metrics";

export function SystemResourcesView() {
  const [window, setWindow] = useState<SystemMetricsWindow>("live");
  const resourcesQuery = useQuery({
    queryKey: ["system-resources"],
    queryFn: getSystemResources,
    refetchInterval: 2_000,
  });
  const metrics = useSystemMetrics(window);

  return (
    <SystemResourcesPanel
      resources={resourcesQuery.data?.data}
      samples={metrics.samples}
      windowMs={metrics.windowMs}
      intervalMs={metrics.intervalMs}
      window={window}
      onWindowChange={setWindow}
      fetching={resourcesQuery.isFetching}
    />
  );
}
