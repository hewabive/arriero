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
import { memo, useState } from "react";

import { getWorkloadSession } from "../../api/client";
import { TraceFileModal } from "../proxy/TracesTable";
import { formatLocalDateTime } from "../utils/time";
import { formatDurationMs, formatTokens } from "../views/benchmark-format";
import { WorkloadStat } from "./WorkloadStat";

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

function shortId(traceId: string | null): string {
  return traceId === null ? "—" : traceId.slice(-8);
}

const RequestRows = memo(function RequestRows(props: {
  records: WorkloadRecord[];
  onOpenCapture: (file: ApiProxyTraceFile) => void;
}) {
  const rows = props.records.map((record) => {
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
        <Table.Td>{formatTokens(record.promptTokens)}</Table.Td>
        <Table.Td>{formatTokens(record.cacheReadTokens)}</Table.Td>
        <Table.Td>{formatTokens(record.completionTokens)}</Table.Td>
        <Table.Td>{formatDurationMs(record.thinkTimeMs)}</Table.Td>
        <Table.Td>{formatTokens(record.cacheLossTokens)}</Table.Td>
        <Table.Td>{formatTokens(record.responseReuseTokens)}</Table.Td>
        <Table.Td>
          {file && (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => props.onOpenCapture(file)}
            >
              Capture
            </Button>
          )}
        </Table.Td>
      </Table.Tr>
    );
  });
  return <>{rows}</>;
});

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
                <WorkloadStat
                  label="Started"
                  value={formatLocalDateTime(detail.summary.startedAt)}
                />
                <WorkloadStat
                  label="Requests"
                  value={String(detail.summary.records)}
                />
                <WorkloadStat
                  label="Replayable"
                  value={String(detail.summary.replayable)}
                />
                <WorkloadStat
                  label="Errors"
                  value={String(detail.summary.errors)}
                />
                <WorkloadStat
                  label="Largest prompt"
                  value={formatTokens(detail.summary.maxPromptTokens)}
                />
                <WorkloadStat
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
                    <RequestRows
                      records={detail.records}
                      onOpenCapture={setOpenFile}
                    />
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
