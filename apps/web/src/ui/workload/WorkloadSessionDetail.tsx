import type {
  ApiProxyTraceFile,
  WorkloadOutcome,
  WorkloadRecord,
  WorkloadRecordIssue,
} from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { getWorkloadSession } from "../../api/client";
import { TraceFileModal } from "../proxy/TracesTable";
import { formatLocalDateTime } from "../utils/time";
import { formatDurationMs, formatTokens } from "../views/benchmark-format";

const OUTCOME_COLORS: Record<WorkloadOutcome, string> = {
  success: "green",
  "client-abort": "yellow",
  "not-served": "gray",
  error: "red",
};

const OUTCOME_LABELS: Record<WorkloadOutcome, string> = {
  success: "Served",
  "client-abort": "Client abort",
  "not-served": "Not served",
  error: "Error",
};

const ISSUE_LABELS: Record<WorkloadRecordIssue, string> = {
  "capture-after-rewrite": "A rewriting node runs after the capture",
  "unsupported-operation": "Operation cannot be replayed",
  "stateful-request": "History kept on the server",
  "capture-unreadable": "Capture file is missing",
  "body-not-object": "Body has no messages",
};

function tokens(value: number | null): string {
  return value === null ? "—" : formatTokens(value);
}

function captureFile(record: WorkloadRecord): ApiProxyTraceFile | null {
  if (record.capturePath === null) {
    return null;
  }
  return {
    name: record.capturePath.split("/").at(-1) ?? record.capturePath,
    path: record.capturePath,
    kind: "capture-request",
    label: null,
    bytes: 0,
    createdAt: record.at,
  };
}

function SummaryStat(props: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {props.label}
      </Text>
      <Text fw={600}>{props.value}</Text>
    </Stack>
  );
}

export function WorkloadSessionDetail(props: {
  sessionId: string;
  onBack: () => void;
}) {
  const [openFile, setOpenFile] = useState<ApiProxyTraceFile | null>(null);
  const sessionQuery = useQuery({
    queryKey: ["workload-session", props.sessionId],
    queryFn: () => getWorkloadSession(props.sessionId),
  });
  const detail = sessionQuery.data?.data;
  const shortId = (traceId: string | null) =>
    traceId === null ? "—" : traceId.slice(-8);

  return (
    <Stack gap="md">
      <Group>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<ArrowLeft size={14} />}
          onClick={props.onBack}
        >
          Sessions
        </Button>
      </Group>
      {sessionQuery.isError && (
        <Text size="sm" c="red">
          {(sessionQuery.error as Error).message}
        </Text>
      )}
      {detail && (
        <>
          <Paper withBorder p="md" radius="sm">
            <Stack gap="sm">
              <Title order={4}>
                {detail.summary.sourceName ?? "Anonymous"} ·{" "}
                {detail.summary.modelId}
              </Title>
              <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="md">
                <SummaryStat
                  label="Started"
                  value={formatLocalDateTime(detail.summary.startedAt)}
                />
                <SummaryStat
                  label="Requests"
                  value={String(detail.summary.records)}
                />
                <SummaryStat
                  label="Replayable"
                  value={String(detail.summary.replayable)}
                />
                <SummaryStat
                  label="Errors"
                  value={String(detail.summary.errors)}
                />
                <SummaryStat
                  label="Largest prompt"
                  value={tokens(detail.summary.maxPromptTokens)}
                />
                <SummaryStat
                  label="Targets"
                  value={detail.summary.targetNames.join(", ") || "—"}
                />
              </SimpleGrid>
            </Stack>
          </Paper>
          <Paper withBorder p="md" radius="sm">
            <Stack gap="sm">
              <Title order={4}>Requests</Title>
              <Table.ScrollContainer minWidth={1100}>
                <Table striped verticalSpacing={4}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Request</Table.Th>
                      <Table.Th>Extends</Table.Th>
                      <Table.Th>Messages</Table.Th>
                      <Table.Th>Outcome</Table.Th>
                      <Table.Th>Prompt</Table.Th>
                      <Table.Th>From cache</Table.Th>
                      <Table.Th>Answer</Table.Th>
                      <Table.Th>Pause before</Table.Th>
                      <Table.Th>Lost cache</Table.Th>
                      <Table.Th>Reused answer</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {detail.records.map((record) => {
                      const file = captureFile(record);
                      return (
                        <Table.Tr key={record.traceId}>
                          <Table.Td>{formatLocalDateTime(record.at)}</Table.Td>
                          <Table.Td>
                            <Text size="sm" ff="monospace">
                              {shortId(record.traceId)}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" ff="monospace">
                              {shortId(record.parentTraceId)}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {record.messageCount === null
                              ? "—"
                              : record.sharedMessages === null
                                ? String(record.messageCount)
                                : `${record.messageCount} (${record.sharedMessages} shared)`}
                          </Table.Td>
                          <Table.Td>
                            <Stack gap={2}>
                              <Badge
                                size="sm"
                                variant="light"
                                color={OUTCOME_COLORS[record.outcome]}
                              >
                                {OUTCOME_LABELS[record.outcome]}
                              </Badge>
                              {record.issue !== null && (
                                <Text size="xs" c="dimmed">
                                  {ISSUE_LABELS[record.issue]}
                                </Text>
                              )}
                            </Stack>
                          </Table.Td>
                          <Table.Td>{tokens(record.promptTokens)}</Table.Td>
                          <Table.Td>{tokens(record.cacheReadTokens)}</Table.Td>
                          <Table.Td>{tokens(record.completionTokens)}</Table.Td>
                          <Table.Td>
                            {formatDurationMs(record.thinkTimeMs)}
                          </Table.Td>
                          <Table.Td>{tokens(record.cacheLossTokens)}</Table.Td>
                          <Table.Td>
                            {tokens(record.responseReuseTokens)}
                          </Table.Td>
                          <Table.Td>
                            {file && (
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                onClick={() => setOpenFile(file)}
                              >
                                Capture
                              </Button>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Stack>
          </Paper>
        </>
      )}
      <TraceFileModal file={openFile} onClose={() => setOpenFile(null)} />
    </Stack>
  );
}
