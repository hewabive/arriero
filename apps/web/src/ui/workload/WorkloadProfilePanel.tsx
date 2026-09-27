import type {
  WorkloadProfile,
  WorkloadProfileWindow,
  WorkloadRankedWindow,
  WorkloadTimeRange,
  WorkloadWindowRank,
} from "@arriero/core";
import {
  Button,
  Group,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import {
  getApiProxyTraceFacets,
  getWorkloadProfile,
  listWorkloadWindows,
} from "../../api/client";
import { MetricChart, MetricHoverProvider } from "../components/MetricChart";
import { formatLocalClock, formatLocalDateTime } from "../utils/time";
import { formatPercent, formatTokens } from "../views/benchmark-format";
import {
  WORKLOAD_PERIOD_OPTIONS,
  WORKLOAD_WINDOW_OPTIONS,
  facetSelectData,
  isWorkloadPeriod,
  workloadPeriodRange,
  workloadStepMinutes,
  type WorkloadScopeState,
} from "./workload-scope";

function optionalTokens(value: number | null): string {
  return value === null ? "—" : formatTokens(value);
}

function formatWindowSpan(window: WorkloadProfileWindow): string {
  return `${formatLocalDateTime(window.startAt)} – ${formatLocalClock(Date.parse(window.endAt))}`;
}

function PeriodStat(props: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {props.label}
      </Text>
      <Text fw={600}>{props.value}</Text>
    </Stack>
  );
}

function PeriodSummary(props: { period: WorkloadProfileWindow }) {
  const period = props.period;
  return (
    <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} spacing="md">
      <PeriodStat label="Requests" value={String(period.requests)} />
      <PeriodStat label="Errors" value={String(period.errors)} />
      <PeriodStat label="Sessions" value={String(period.activeSessions)} />
      <PeriodStat
        label="Served from cache"
        value={formatPercent(period.cachedShare)}
      />
      <PeriodStat
        label="Fresh prefill"
        value={optionalTokens(period.freshPrefillTokens)}
      />
      <PeriodStat
        label="Lost cache"
        value={optionalTokens(period.cacheLossTokens)}
      />
      <PeriodStat
        label="Reused answers"
        value={optionalTokens(period.responseReuseTokens)}
      />
    </SimpleGrid>
  );
}

function ProfileCharts(props: { profile: WorkloadProfile }) {
  const { windows, stepMinutes } = props.profile;
  const axis = useMemo(() => {
    const times = windows.map((window) => Date.parse(window.startAt));
    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? first;
    const intervalMs = stepMinutes * 60_000;
    return { times, windowMs: Math.max(intervalMs, last - first), intervalMs };
  }, [windows, stepMinutes]);
  const series = useMemo(
    () => ({
      inFlight: [
        {
          id: "in-flight",
          label: "In flight",
          tone: "gpuLoad" as const,
          values: windows.map((window) => window.meanInFlight),
        },
      ],
      requests: [
        {
          id: "requests",
          label: "Started",
          tone: "cpu" as const,
          values: windows.map((window) => window.requests),
        },
      ],
      prompt: [
        {
          id: "fresh",
          label: "Fresh prefill",
          tone: "outbound" as const,
          values: windows.map((window) => window.freshPrefillTokens),
        },
        {
          id: "cached",
          label: "From cache",
          tone: "memory" as const,
          values: windows.map((window) => window.cachedPromptTokens),
        },
      ],
    }),
    [windows],
  );
  const period = props.profile.period;
  return (
    <MetricHoverProvider>
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="md">
        <MetricChart
          title="Requests in flight"
          headline={period.meanInFlight.toFixed(2)}
          axis={axis}
          domain={{ kind: "auto", minimumMax: 1 }}
          formatValue={(value) => value.toFixed(2)}
          series={series.inFlight}
        />
        <MetricChart
          title="Requests started"
          headline={String(period.requests)}
          axis={axis}
          domain={{ kind: "auto", minimumMax: 1 }}
          formatValue={(value) => String(Math.round(value))}
          series={series.requests}
        />
        <MetricChart
          title="Prompt tokens"
          headline={optionalTokens(period.freshPrefillTokens)}
          axis={axis}
          domain={{ kind: "auto", minimumMax: 1 }}
          formatValue={formatTokens}
          series={series.prompt}
        />
      </SimpleGrid>
    </MetricHoverProvider>
  );
}

function RankedWindows(props: {
  windows: WorkloadRankedWindow[];
  rank: WorkloadWindowRank;
  onOpenWindow: (range: WorkloadTimeRange) => void;
}) {
  if (props.windows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No error-free window with requests in this period.
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table striped highlightOnHover verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Window</Table.Th>
            <Table.Th>Requests</Table.Th>
            <Table.Th>Sessions</Table.Th>
            <Table.Th>In flight</Table.Th>
            <Table.Th>Prompt p50</Table.Th>
            <Table.Th>Fresh prefill</Table.Th>
            <Table.Th>From cache</Table.Th>
            <Table.Th>
              {props.rank === "typical" ? "Deviation" : "Load"}
            </Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.windows.map((window) => (
            <Table.Tr key={window.startAt}>
              <Table.Td>{formatWindowSpan(window)}</Table.Td>
              <Table.Td>{window.requests}</Table.Td>
              <Table.Td>{window.activeSessions}</Table.Td>
              <Table.Td>{window.meanInFlight.toFixed(2)}</Table.Td>
              <Table.Td>{optionalTokens(window.promptTokensP50)}</Table.Td>
              <Table.Td>{optionalTokens(window.freshPrefillTokens)}</Table.Td>
              <Table.Td>{formatPercent(window.cachedShare)}</Table.Td>
              <Table.Td>{window.score.toFixed(2)}</Table.Td>
              <Table.Td>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() =>
                    props.onOpenWindow({
                      from: window.startAt,
                      to: window.endAt,
                    })
                  }
                >
                  Sessions
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function WorkloadProfilePanel(props: {
  scope: WorkloadScopeState;
  onScopeChange: (scope: WorkloadScopeState) => void;
  onOpenWindow: (range: WorkloadTimeRange) => void;
}) {
  const [windowMinutes, setWindowMinutes] = useState(15);
  const [rank, setRank] = useState<WorkloadWindowRank>("typical");
  const [anchor, setAnchor] = useState(() => Date.now());
  const range = workloadPeriodRange(props.scope.period, anchor);
  const stepMinutes = workloadStepMinutes(props.scope.period, windowMinutes);
  const scopeQuery = {
    from: range.from,
    to: range.to,
    windowMinutes,
    stepMinutes,
    ...(props.scope.sourceId ? { sourceId: props.scope.sourceId } : {}),
    ...(props.scope.modelId ? { modelId: props.scope.modelId } : {}),
  };
  const facetsQuery = useQuery({
    queryKey: ["api-proxy-trace-facets"],
    queryFn: getApiProxyTraceFacets,
  });
  const profileQuery = useQuery({
    queryKey: ["workload-profile", scopeQuery],
    queryFn: () => getWorkloadProfile(scopeQuery),
  });
  const windowsQuery = useQuery({
    queryKey: ["workload-windows", scopeQuery, rank],
    queryFn: () => listWorkloadWindows({ ...scopeQuery, rank, limit: 10 }),
  });
  const profile = profileQuery.data?.data;
  const facets = facetsQuery.data?.data;

  return (
    <Stack gap="md">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          size="xs"
          w={160}
          label="Period"
          value={props.scope.period}
          data={WORKLOAD_PERIOD_OPTIONS}
          allowDeselect={false}
          onChange={(value) => {
            if (value && isWorkloadPeriod(value)) {
              props.onScopeChange({ ...props.scope, period: value });
            }
          }}
        />
        <Select
          size="xs"
          w={160}
          label="Window"
          value={String(windowMinutes)}
          data={WORKLOAD_WINDOW_OPTIONS}
          allowDeselect={false}
          onChange={(value) => setWindowMinutes(Number(value ?? 15))}
        />
        <Select
          size="xs"
          w={180}
          label="Source"
          placeholder="All"
          clearable
          value={props.scope.sourceId}
          data={facetSelectData(facets?.sources)}
          onChange={(value) =>
            props.onScopeChange({ ...props.scope, sourceId: value })
          }
        />
        <Select
          size="xs"
          w={200}
          label="Model"
          placeholder="All"
          clearable
          searchable
          value={props.scope.modelId}
          data={facetSelectData(facets?.models)}
          onChange={(value) =>
            props.onScopeChange({ ...props.scope, modelId: value })
          }
        />
        <Button
          size="xs"
          variant="light"
          leftSection={<RefreshCw size={14} />}
          loading={profileQuery.isFetching}
          onClick={() => setAnchor(Date.now())}
        >
          Refresh
        </Button>
      </Group>

      {profileQuery.isError && (
        <Text size="sm" c="red">
          {(profileQuery.error as Error).message}
        </Text>
      )}

      {profile && (
        <Paper withBorder p="md" radius="sm">
          <Stack gap="md">
            <Title order={4}>Period</Title>
            <PeriodSummary period={profile.period} />
            <ProfileCharts profile={profile} />
          </Stack>
        </Paper>
      )}

      <Paper withBorder p="md" radius="sm">
        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap">
            <Title order={4}>Candidate windows</Title>
            <SegmentedControl
              size="xs"
              value={rank}
              data={[
                { value: "typical", label: "Typical" },
                { value: "peak", label: "Peak" },
              ]}
              onChange={(value) =>
                setRank(value === "peak" ? "peak" : "typical")
              }
            />
          </Group>
          <Text size="sm" c="dimmed">
            {rank === "typical"
              ? "Error-free windows closest to the median of the period, least deviation first."
              : "Error-free windows with the most requests in flight."}
          </Text>
          {windowsQuery.data && (
            <RankedWindows
              windows={windowsQuery.data.data}
              rank={rank}
              onOpenWindow={props.onOpenWindow}
            />
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
