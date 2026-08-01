import type {
  ApiProxyRequestTrace,
  ApiProxyStatsSnapshot,
} from "@arriero/core";
import { Button, Group, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Database, Trash2 } from "lucide-react";

import { clearApiProxyCache, getApiProxyCacheStats } from "../../../api/client";
import { formatBytes } from "../../utils/models";
import { formatLocalHour } from "../../utils/time";
import { formatTraceRate, TracesTable } from "../TracesTable";

type StatsSectionProps = {
  snapshot: ApiProxyStatsSnapshot | undefined;
  traces: ApiProxyRequestTrace[];
  loading: boolean;
};

function StatBlock(props: { label: string; value: string }) {
  return (
    <Stack gap={0} miw={120}>
      <Text size="xs" c="dimmed">
        {props.label}
      </Text>
      <Text fw={600} size="lg">
        {props.value}
      </Text>
    </Stack>
  );
}

function ResponseCacheCard() {
  const queryClient = useQueryClient();
  const statsQuery = useQuery({
    queryKey: ["api-proxy-cache-stats"],
    queryFn: getApiProxyCacheStats,
  });
  const clearMutation = useMutation({
    mutationFn: clearApiProxyCache,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["api-proxy-cache-stats"] }),
  });
  const stats = statsQuery.data?.data;
  return (
    <Group gap="md" wrap="wrap" align="center">
      <Group gap="xs">
        <Database size={16} />
        <Text fw={600} size="sm">
          Response cache
        </Text>
      </Group>
      <StatBlock label="Entries" value={String(stats?.entries ?? 0)} />
      <StatBlock label="Size" value={formatBytes(stats?.totalBytes ?? 0)} />
      <Button
        size="compact-sm"
        variant="light"
        color="red"
        leftSection={<Trash2 size={14} />}
        loading={clearMutation.isPending}
        disabled={(stats?.entries ?? 0) === 0}
        onClick={() => clearMutation.mutate()}
      >
        Clear
      </Button>
    </Group>
  );
}

export function StatsSection(props: StatsSectionProps) {
  const snapshot = props.snapshot;
  const totals = snapshot?.totals;
  const hasData = Boolean(totals && totals.requests > 0);

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <BarChart3 size={18} />
            <Title order={4}>Statistics</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Last {snapshot?.hours ?? 24}h.
          </Text>
        </Group>

        <ResponseCacheCard />

        {!hasData && (
          <Text c="dimmed" size="sm">
            {props.loading ? "Loading…" : "No proxied requests recorded yet."}
          </Text>
        )}

        {hasData && totals && (
          <>
            <Group gap="xl" wrap="wrap">
              <StatBlock label="Requests" value={String(totals.requests)} />
              <StatBlock
                label="Completion tokens"
                value={String(totals.completionTokens)}
              />
              <StatBlock
                label="Avg rate"
                value={formatTraceRate(totals.ratePerSecond)}
              />
              <StatBlock
                label="With tokens"
                value={`${totals.requestsWithTokens}/${totals.requests}`}
              />
              <StatBlock label="Cache hits" value={String(totals.cacheHits)} />
              <StatBlock label="Errors" value={String(totals.errors)} />
            </Group>

            <Table striped withTableBorder fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Hour</Table.Th>
                  <Table.Th>Requests</Table.Th>
                  <Table.Th>Errors</Table.Th>
                  <Table.Th>Cache hits</Table.Th>
                  <Table.Th>Tokens</Table.Th>
                  <Table.Th>Rate</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(snapshot?.buckets ?? []).slice(0, 12).map((bucket) => (
                  <Table.Tr key={bucket.hour}>
                    <Table.Td>{formatLocalHour(bucket.hour)}</Table.Td>
                    <Table.Td>{bucket.requests}</Table.Td>
                    <Table.Td>{bucket.errors}</Table.Td>
                    <Table.Td>{bucket.cacheHits}</Table.Td>
                    <Table.Td>{bucket.completionTokens}</Table.Td>
                    <Table.Td>{formatTraceRate(bucket.ratePerSecond)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </>
        )}

        {props.traces.length > 0 && (
          <Stack gap="xs">
            <Text fw={600} size="sm">
              Recent requests
            </Text>
            <TracesTable traces={props.traces.slice(0, 50)} />
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
