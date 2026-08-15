import { isBenchmarkClassSupported } from "@arriero/core";
import {
  Alert,
  Badge,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { CircleAlert } from "lucide-react";

import { countLabel } from "../utils/plural";

import { BenchmarkHeadline } from "./BenchmarkHeadline";
import { BenchmarkTimeline } from "./BenchmarkTimeline";
import type { BenchmarkViewController } from "./use-benchmark-view";

function fmtRate(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function fmtPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function fmtMs(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(0)} ms`;
}

export function BenchmarkRunDetail({ fm }: { fm: BenchmarkViewController }) {
  const run = fm.selectedRun;
  if (!run) {
    return null;
  }
  const summary = run.summary;
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={2}>
            <Title order={4}>{run.label ?? `Run ${run.id.slice(0, 8)}`}</Title>
            <Text size="xs" c="dimmed">
              {run.scenario.target.instanceName}
              {run.snapshot
                ? ` · ${run.snapshot.engineKind} · ${run.snapshot.model ?? "unknown model"}`
                : ""}
              {` · ${run.scenario.mode}`}
              {run.scenario.repetitions > 1
                ? ` · ${run.scenario.repetitions} waves`
                : ""}
            </Text>
          </Stack>
          {summary && (
            <Group gap="xs" wrap="wrap">
              <Badge variant="light">
                {countLabel(summary.requestCount, "request")}
              </Badge>
              {summary.headline === null && (
                <>
                  <Badge variant="light">
                    {summary.totalCompletionTokens.toFixed(0)} tokens
                  </Badge>
                  <Badge variant="light">
                    {(summary.wallMs / 1000).toFixed(1)} s wall
                  </Badge>
                  {summary.acceptanceRate !== null && (
                    <Badge variant="light" color="grape">
                      draft acceptance {fmtPercent(summary.acceptanceRate)}
                    </Badge>
                  )}
                </>
              )}
              {summary.failedRequestCount > 0 && (
                <Badge variant="light" color="red">
                  {summary.failedRequestCount} failed
                </Badge>
              )}
            </Group>
          )}
        </Group>

        {summary && <BenchmarkHeadline summary={summary} />}

        {run.error && (
          <Alert
            color="red"
            icon={<CircleAlert size={16} />}
            title="Run failed"
          >
            {run.error}
          </Alert>
        )}
        {run.warnings.length > 0 && (
          <Alert
            color="yellow"
            icon={<CircleAlert size={16} />}
            title="Validity warnings"
          >
            <Stack gap={2}>
              {run.warnings.map((warning, index) => (
                <Text key={index} size="sm">
                  {warning}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}

        {fm.result && <BenchmarkTimeline result={fm.result} />}
        {run.status !== "running" && !fm.result && !fm.resultLoading && (
          <Text c="dimmed" size="sm">
            No timeline available for this run.
          </Text>
        )}

        {summary && summary.segmentClasses.length > 0 && (
          <Stack gap={4}>
            <Title order={4}>Phase mix</Title>
            <Table.ScrollContainer minWidth={560}>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Prefilling</Table.Th>
                    <Table.Th>Decoding</Table.Th>
                    <Table.Th>Time share</Table.Th>
                    <Table.Th>Wall</Table.Th>
                    <Table.Th>Decode tok/s</Table.Th>
                    <Table.Th>Per-request tok/s</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {summary.segmentClasses.map((entry, index) => {
                    const supported = isBenchmarkClassSupported(entry);
                    return (
                      <Table.Tr key={index}>
                        <Table.Td>{entry.prefillCount}</Table.Td>
                        <Table.Td>{entry.decodeCount}</Table.Td>
                        <Table.Td>{fmtPercent(entry.wallShare)}</Table.Td>
                        <Table.Td>
                          {(entry.wallMs / 1000).toFixed(2)} s
                        </Table.Td>
                        <Table.Td>
                          {supported
                            ? fmtRate(entry.decodeTokensPerSecond)
                            : "—"}
                        </Table.Td>
                        <Table.Td>
                          {supported
                            ? fmtRate(entry.perRequestDecodeTokensPerSecond)
                            : "—"}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Text size="xs" c="dimmed">
              Rates are reported only for classes that held long enough to
              measure — boundary slivers show as —.
            </Text>
          </Stack>
        )}

        {summary && summary.topics.length > 0 && (
          <Stack gap={4}>
            <Title order={4}>Topics</Title>
            <Table.ScrollContainer minWidth={560}>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Topic</Table.Th>
                    <Table.Th>Requests</Table.Th>
                    <Table.Th>Solo tok/s</Table.Th>
                    <Table.Th>Contended tok/s</Table.Th>
                    <Table.Th>Draft acceptance</Table.Th>
                    <Table.Th>Avg TTFT</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {summary.topics.map((topic, index) => (
                    <Table.Tr key={index}>
                      <Table.Td>{`${topic.topic}/${topic.language}`}</Table.Td>
                      <Table.Td>{topic.requestCount}</Table.Td>
                      <Table.Td>
                        {fmtRate(topic.soloDecodeTokensPerSecond)}
                      </Table.Td>
                      <Table.Td>
                        {fmtRate(topic.contendedDecodeTokensPerSecond)}
                      </Table.Td>
                      <Table.Td>{fmtPercent(topic.acceptanceRate)}</Table.Td>
                      <Table.Td>
                        {fmtMs(topic.averageTimeToFirstTokenMs)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
