import {
  rankWorkloadWindows,
  type WorkloadProfile,
  type WorkloadProfileWindow,
  type WorkloadRankedWindow,
  type WorkloadTimeRange,
  type WorkloadWindowRank,
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

import { getWorkloadProfile } from "../../api/client";
import { MetricChart, MetricHoverProvider } from "../components/MetricChart";
import { formatPercent, formatTokens } from "../views/benchmark-format";
import { WorkloadScopeFilters } from "./WorkloadScopeFilters";
import { WorkloadStat } from "./WorkloadStat";
import {
  WORKLOAD_WINDOW_OPTIONS,
  formatWorkloadRange,
  workloadPeriodRange,
  workloadScopeQuery,
  workloadStepMinutes,
  type WorkloadScopeState,
} from "./workload-scope";

const RANKED_WINDOW_LIMIT = 10;

function PeriodSummary(props: { period: WorkloadProfileWindow }) {
  const period = props.period;
  return (
    <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} spacing="md">
      <WorkloadStat label="Requests" value={String(period.requests)} />
      <WorkloadStat label="Errors" value={String(period.errors)} />
      <WorkloadStat label="Sessions" value={String(period.activeSessions)} />
      <WorkloadStat
        label="Served from cache"
        value={formatPercent(period.cachedShare)}
      />
      <WorkloadStat
        label="Fresh prefill"
        value={formatTokens(period.freshPrefillTokens)}
      />
      <WorkloadStat
        label="Lost cache"
        value={formatTokens(period.cacheLossTokens)}
      />
      <WorkloadStat
        label="Reused answers"
        value={formatTokens(period.responseReuseTokens)}
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
          headline={formatTokens(period.freshPrefillTokens)}
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
              <Table.Td>
                {formatWorkloadRange(window.startAt, window.endAt)}
              </Table.Td>
              <Table.Td>{window.requests}</Table.Td>
              <Table.Td>{window.activeSessions}</Table.Td>
              <Table.Td>{window.meanInFlight.toFixed(2)}</Table.Td>
              <Table.Td>{formatTokens(window.promptTokensP50)}</Table.Td>
              <Table.Td>{formatTokens(window.freshPrefillTokens)}</Table.Td>
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
  const profileScope = {
    ...workloadScopeQuery(props.scope, range),
    windowMinutes,
    stepMinutes,
  };
  const profileQuery = useQuery({
    queryKey: ["workload-profile", profileScope],
    queryFn: () => getWorkloadProfile(profileScope),
  });
  const profile = profileQuery.data?.data;
  const rankedWindows = useMemo(
    () =>
      profile
        ? rankWorkloadWindows(profile.windows, rank, RANKED_WINDOW_LIMIT)
        : null,
    [profile, rank],
  );

  return (
    <Stack gap="md">
      <WorkloadScopeFilters
        scope={props.scope}
        onScopeChange={props.onScopeChange}
        afterPeriod={
          <Select
            size="xs"
            w={160}
            label="Window"
            value={String(windowMinutes)}
            data={WORKLOAD_WINDOW_OPTIONS}
            allowDeselect={false}
            onChange={(value) => setWindowMinutes(Number(value ?? 15))}
          />
        }
      >
        <Button
          size="xs"
          variant="light"
          leftSection={<RefreshCw size={14} />}
          loading={profileQuery.isFetching}
          onClick={() => setAnchor(Date.now())}
        >
          Refresh
        </Button>
      </WorkloadScopeFilters>

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
          {rankedWindows && (
            <RankedWindows
              windows={rankedWindows}
              rank={rank}
              onOpenWindow={props.onOpenWindow}
            />
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
