import type {
  WorkloadLinkingGroup,
  WorkloadSessionSummary,
  WorkloadTimeRange,
} from "@arriero/core";
import {
  Badge,
  Button,
  CloseButton,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Snowflake } from "lucide-react";
import { useMemo, useState } from "react";

import {
  getApiProxyTraceFacets,
  getWorkloadLinking,
  listWorkloadSessions,
} from "../../api/client";
import { countLabel } from "../utils/plural";
import { FreezeDatasetModal } from "./FreezeDatasetModal";
import { formatLocalClock, formatLocalDateTime } from "../utils/time";
import {
  formatDurationMs,
  formatPercent,
  formatTokens,
} from "../views/benchmark-format";
import {
  WORKLOAD_PERIOD_OPTIONS,
  facetSelectData,
  isWorkloadPeriod,
  workloadPeriodRange,
  type WorkloadScopeState,
} from "./workload-scope";

const PAGE_SIZE = 100;

function sessionDurationMs(session: WorkloadSessionSummary): number | null {
  const started = Date.parse(session.startedAt);
  const ended = Date.parse(session.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended)
    ? ended - started
    : null;
}

function LinkingReport(props: { groups: WorkloadLinkingGroup[] }) {
  if (props.groups.length === 0) {
    return null;
  }
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Title order={4}>Session linking</Title>
        <Text size="sm" c="dimmed">
          Requests are linked to the earlier request whose messages they extend.
          Where a client sends its own session id, the agreement column checks
          the linking against it.
        </Text>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing={4}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Source</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th>Linked</Table.Th>
                <Table.Th>Sessions</Table.Th>
                <Table.Th>Client sessions</Table.Th>
                <Table.Th>Agreement</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.groups.map((group) => (
                <Table.Tr key={`${group.sourceId ?? ""}:${group.modelId}`}>
                  <Table.Td>{group.sourceName ?? "Anonymous"}</Table.Td>
                  <Table.Td>{group.modelId}</Table.Td>
                  <Table.Td>
                    {group.linkedRecords} of {group.linkableRecords} (
                    {formatPercent(
                      group.linkableRecords === 0
                        ? null
                        : group.linkedRecords / group.linkableRecords,
                    )}
                    )
                  </Table.Td>
                  <Table.Td>{group.sessions}</Table.Td>
                  <Table.Td>{group.clientSessions}</Table.Td>
                  <Table.Td>
                    {group.clientSessionPairs === 0
                      ? "—"
                      : `${group.clientSessionAgreeing} of ${group.clientSessionPairs}`}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Paper>
  );
}

export function WorkloadSessionsPanel(props: {
  scope: WorkloadScopeState;
  onScopeChange: (scope: WorkloadScopeState) => void;
  windowRange: WorkloadTimeRange | null;
  onClearWindow: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenDataset: (datasetId: string) => void;
}) {
  const [anchor] = useState(() => Date.now());
  const [freezing, setFreezing] = useState<WorkloadTimeRange | null>(null);
  const population = workloadPeriodRange(props.scope.period, anchor);
  const range =
    props.windowRange ?? workloadPeriodRange(props.scope.period, anchor);
  const scopeQuery = {
    from: range.from,
    to: range.to,
    ...(props.scope.sourceId ? { sourceId: props.scope.sourceId } : {}),
    ...(props.scope.modelId ? { modelId: props.scope.modelId } : {}),
  };
  const facetsQuery = useQuery({
    queryKey: ["api-proxy-trace-facets"],
    queryFn: getApiProxyTraceFacets,
  });
  const linkingQuery = useQuery({
    queryKey: ["workload-linking", range],
    queryFn: () => getWorkloadLinking(range),
  });
  const sessionsQuery = useInfiniteQuery({
    queryKey: ["workload-sessions", scopeQuery],
    queryFn: ({ pageParam }) =>
      listWorkloadSessions({
        ...scopeQuery,
        limit: PAGE_SIZE,
        ...(pageParam
          ? { beforeAt: pageParam.at, beforeId: pageParam.sessionId }
          : {}),
      }),
    initialPageParam: null as { at: string; sessionId: string } | null,
    getNextPageParam: (lastPage) => {
      const last = lastPage.data.at(-1);
      return lastPage.data.length < PAGE_SIZE || !last
        ? null
        : { at: last.startedAt, sessionId: last.sessionId };
    },
  });
  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [sessionsQuery.data],
  );
  const facets = facetsQuery.data?.data;

  return (
    <Stack gap="md">
      <Group gap="xs" align="flex-end" wrap="wrap">
        {props.windowRange ? (
          <Stack gap={2}>
            <Text size="xs" fw={500}>
              Window
            </Text>
            <Badge
              size="lg"
              variant="light"
              rightSection={
                <CloseButton
                  size="xs"
                  aria-label="Show the whole period"
                  onClick={props.onClearWindow}
                />
              }
            >
              {formatLocalDateTime(props.windowRange.from)} –{" "}
              {formatLocalClock(Date.parse(props.windowRange.to))}
            </Badge>
          </Stack>
        ) : (
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
        )}
        {props.windowRange && (
          <Button
            size="xs"
            variant="light"
            leftSection={<Snowflake size={14} />}
            onClick={() => setFreezing(props.windowRange)}
          >
            Freeze window
          </Button>
        )}
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
      </Group>

      <FreezeDatasetModal
        window={freezing}
        population={population}
        sourceId={props.scope.sourceId}
        modelId={props.scope.modelId}
        onClose={() => setFreezing(null)}
        onFrozen={(datasetId) => {
          setFreezing(null);
          props.onOpenDataset(datasetId);
        }}
      />

      <LinkingReport groups={linkingQuery.data?.data.groups ?? []} />

      <Paper withBorder p="md" radius="sm">
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={4}>Sessions</Title>
            <Text size="sm" c="dimmed">
              {sessionsQuery.isLoading
                ? "Loading…"
                : countLabel(sessions.length, "session")}
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Counts cover the requests inside the selected range; a session that
            began earlier shows its first request in the range.
          </Text>
          {sessionsQuery.isError && (
            <Text size="sm" c="red">
              {(sessionsQuery.error as Error).message}
            </Text>
          )}
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>First request</Table.Th>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>Model</Table.Th>
                  <Table.Th>Requests</Table.Th>
                  <Table.Th>Replayable</Table.Th>
                  <Table.Th>Errors</Table.Th>
                  <Table.Th>Aborted</Table.Th>
                  <Table.Th>Largest prompt</Table.Th>
                  <Table.Th>Duration</Table.Th>
                  <Table.Th>Targets</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sessions.map((session) => (
                  <Table.Tr
                    key={session.sessionId}
                    style={{ cursor: "pointer" }}
                    onClick={() => props.onOpenSession(session.sessionId)}
                  >
                    <Table.Td>
                      {formatLocalDateTime(session.startedAt)}
                    </Table.Td>
                    <Table.Td>{session.sourceName ?? "Anonymous"}</Table.Td>
                    <Table.Td>{session.modelId}</Table.Td>
                    <Table.Td>{session.records}</Table.Td>
                    <Table.Td>{session.replayable}</Table.Td>
                    <Table.Td>
                      {session.errors > 0 ? (
                        <Text size="sm" c="red">
                          {session.errors}
                        </Text>
                      ) : (
                        0
                      )}
                    </Table.Td>
                    <Table.Td>{session.clientAborts}</Table.Td>
                    <Table.Td>
                      {session.maxPromptTokens === null
                        ? "—"
                        : formatTokens(session.maxPromptTokens)}
                    </Table.Td>
                    <Table.Td>
                      {formatDurationMs(sessionDurationMs(session))}
                    </Table.Td>
                    <Table.Td>{session.targetNames.join(", ")}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {sessionsQuery.hasNextPage && (
            <Group justify="center">
              <Button
                size="xs"
                variant="light"
                loading={sessionsQuery.isFetchingNextPage}
                onClick={() => void sessionsQuery.fetchNextPage()}
              >
                Load more
              </Button>
            </Group>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
