import { Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import {
  getApiProxyRuntime,
  getApiProxyStats,
  listApiProxyTraceHistory,
} from "../../api/client";
import { useProxyConfig } from "../proxy/data";
import { ProxyLoadSection, StatsSection } from "../proxy/sections/index";

export function ProxyDashboardView() {
  const { targetById } = useProxyConfig();

  const statsQuery = useQuery({
    queryKey: ["api-proxy-stats"],
    queryFn: () => getApiProxyStats(24),
    refetchInterval: 10_000,
  });
  const tracesQuery = useQuery({
    queryKey: ["api-proxy-traces"],
    queryFn: () => listApiProxyTraceHistory({ limit: 50 }),
    refetchInterval: 10_000,
  });
  const runtimeQuery = useQuery({
    queryKey: ["api-proxy-runtime"],
    queryFn: getApiProxyRuntime,
    refetchInterval: 5_000,
  });

  return (
    <Stack gap="md">
      <ProxyLoadSection
        runtime={runtimeQuery.data?.data.targets ?? []}
        targetById={targetById}
        refreshing={runtimeQuery.isFetching}
      />

      <StatsSection
        snapshot={statsQuery.data?.data}
        traces={tracesQuery.data?.data ?? []}
        loading={statsQuery.isLoading}
      />
    </Stack>
  );
}
