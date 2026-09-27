import type {
  BenchmarkReplayFidelity,
  BenchmarkReplayScenario,
  BenchmarkReplaySnapshot,
  BenchmarkReplaySummary,
} from "@arriero/core";
import {
  Badge,
  Code,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";

import { countLabel } from "../utils/plural";
import {
  formatDurationMs,
  formatPercent,
  formatRate,
  formatTokens,
} from "./benchmark-format";

function tokens(value: number | null): string {
  return value === null ? "—" : formatTokens(value);
}

export function replayScenarioLine(scenario: BenchmarkReplayScenario): string {
  const arrival =
    scenario.arrival.kind === "recorded"
      ? "recorded arrival"
      : scenario.arrival.kind === "together"
        ? "together"
        : `every ${formatDurationMs(scenario.arrival.intervalMs)}`;
  const cap =
    scenario.arrival.kind !== "recorded" &&
    scenario.arrival.concurrencyCap !== null
      ? ` · at most ${scenario.arrival.concurrencyCap} in flight`
      : "";
  const think =
    scenario.thinkTime.kind === "scaled"
      ? `think ×${scenario.thinkTime.factor}`
      : scenario.thinkTime.kind === "capped"
        ? `think ≤ ${formatDurationMs(scenario.thinkTime.maxMs)}`
        : `think ${scenario.thinkTime.kind}`;
  return [
    arrival + cap,
    think,
    `priming ${scenario.priming}`,
    scenario.idleSkipping ? "idle skipped" : "idle kept",
    `ceiling ${scenario.outputCeiling}`,
    ...(scenario.imitateClientAborts ? ["aborts imitated"] : []),
  ].join(" · ");
}

function Hash({ value }: { value: string }) {
  return (
    <Tooltip label={value}>
      <Code>{value.slice(0, 12)}</Code>
    </Tooltip>
  );
}

function verificationColor(
  verification: NonNullable<BenchmarkReplaySnapshot["flush"]>["verification"],
): string {
  return verification === "passed"
    ? "teal"
    : verification === "failed"
      ? "red"
      : "yellow";
}

function ReplaySnapshotCard({ replay }: { replay: BenchmarkReplaySnapshot }) {
  const flush = replay.flush;
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap={6}>
        <Group gap="xs" wrap="wrap">
          <Text size="sm" fw={500}>
            {replay.datasetName}
          </Text>
          <Text size="xs" c="dimmed">
            dataset
          </Text>
          <Hash value={replay.datasetId} />
          <Text size="xs" c="dimmed">
            prepared bodies
          </Text>
          <Hash value={replay.preparedBodyHash} />
        </Group>
        <Group gap="xs" wrap="wrap">
          <Badge variant="light">
            {countLabel(replay.segmentCount, "segment")}
          </Badge>
          <Badge variant="light">
            {countLabel(replay.recordCount, "request")}
          </Badge>
          <Badge variant="light">
            {countLabel(replay.primedSegmentCount, "primed segment")}
          </Badge>
          {replay.contextTokens !== null && (
            <Badge variant="light">
              context {replay.contextTokens.toLocaleString()}
            </Badge>
          )}
          {flush && (
            <Badge variant="light" color="grape">
              flush {flush.method}
            </Badge>
          )}
          {flush?.verification && (
            <Tooltip
              label={
                flush.promptTokens === null
                  ? "the engine reported no cached prompt tokens"
                  : `first dataset request: ${flush.cachedPromptTokens ?? "?"} of ${flush.promptTokens} prompt tokens from cache`
              }
            >
              <Badge
                variant="light"
                color={verificationColor(flush.verification)}
              >
                flush {flush.verification}
              </Badge>
            </Tooltip>
          )}
        </Group>
        {flush && (
          <Text size="xs" c="dimmed">
            {flush.detail}
          </Text>
        )}
        {replay.reservedInstances.length > 0 && (
          <Text size="xs" c="dimmed">
            Proxy blocked during the run for{" "}
            {replay.reservedInstances.join(", ")}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function FidelityCard({ fidelity }: { fidelity: BenchmarkReplayFidelity }) {
  const recordedFresh =
    fidelity.recordedPromptTokens - fidelity.recordedCachedPromptTokens;
  const replayedFresh =
    fidelity.replayedPromptTokens - fidelity.replayedCachedPromptTokens;
  const extraFresh = replayedFresh - recordedFresh;
  const unexplained = extraFresh - fidelity.responseReuseTokens;
  return (
    <Stack gap={4}>
      <Title order={4}>Fidelity to the recording</Title>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        <Paper withBorder p="xs" radius="sm">
          <Text size="xs" c="dimmed">
            Fresh prefill, recorded → replayed
          </Text>
          <Text fw={700}>
            {formatTokens(recordedFresh)} → {formatTokens(replayedFresh)}
          </Text>
        </Paper>
        <Paper withBorder p="xs" radius="sm">
          <Text size="xs" c="dimmed">
            Served from cache, recorded → replayed
          </Text>
          <Text fw={700}>
            {formatTokens(fidelity.recordedCachedPromptTokens)} →{" "}
            {formatTokens(fidelity.replayedCachedPromptTokens)}
          </Text>
        </Paper>
        <Paper withBorder p="xs" radius="sm">
          <Text size="xs" c="dimmed">
            Extra prefill explained by response reuse
          </Text>
          <Text fw={700}>
            {formatTokens(
              Math.min(Math.max(0, extraFresh), fidelity.responseReuseTokens),
            )}{" "}
            of {formatTokens(Math.max(0, extraFresh))}
          </Text>
        </Paper>
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        Compared over {countLabel(fidelity.comparedRequestCount, "request")}
        {fidelity.uncomparedRequestCount > 0
          ? `; ${fidelity.uncomparedRequestCount} had no recorded or replayed cache count`
          : ""}
        . Replay cannot reuse the recorded answer from cache, so up to one
        previous answer per turn is prefilled again
        {unexplained > 0
          ? `; ${formatTokens(unexplained)} tokens of extra prefill remain unexplained`
          : ""}
        .
      </Text>
    </Stack>
  );
}

function SegmentTable({ summary }: { summary: BenchmarkReplaySummary }) {
  return (
    <Stack gap={4}>
      <Title order={4}>Segments</Title>
      <Table.ScrollContainer minWidth={960}>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Segment</Table.Th>
              <Table.Th>Session</Table.Th>
              <Table.Th>Turns</Table.Th>
              <Table.Th>Prompt</Table.Th>
              <Table.Th>Cached</Table.Th>
              <Table.Th>TTFT p50</Table.Th>
              <Table.Th>TTFT p95</Table.Th>
              <Table.Th>Decode tok/s</Table.Th>
              <Table.Th>Draft acceptance</Table.Th>
              <Table.Th>Wall</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {summary.segments.map((segment) => (
              <Table.Tr key={segment.segmentIndex}>
                <Table.Td>{segment.segmentIndex + 1}</Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Code>{segment.sessionId.slice(0, 12)}</Code>
                    {segment.primed && (
                      <Badge size="xs" variant="light">
                        primed
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {segment.requestCount}
                  {segment.failedRequestCount > 0
                    ? ` (${segment.failedRequestCount} failed)`
                    : ""}
                </Table.Td>
                <Table.Td>{tokens(segment.promptTokens)}</Table.Td>
                <Table.Td>{tokens(segment.cachedPromptTokens)}</Table.Td>
                <Table.Td>
                  {formatDurationMs(segment.timeToFirstTokenP50Ms)}
                </Table.Td>
                <Table.Td>
                  {formatDurationMs(segment.timeToFirstTokenP95Ms)}
                </Table.Td>
                <Table.Td>{formatRate(segment.decodeTokensPerSecond)}</Table.Td>
                <Table.Td>{formatPercent(segment.acceptanceRate)}</Table.Td>
                <Table.Td>{formatDurationMs(segment.wallMs)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

export function BenchmarkReplayDetail(props: {
  replay: BenchmarkReplaySnapshot | undefined;
  summary: BenchmarkReplaySummary | undefined;
}) {
  return (
    <Stack gap="md">
      {props.replay && <ReplaySnapshotCard replay={props.replay} />}
      {props.summary && <SegmentTable summary={props.summary} />}
      {props.summary?.fidelity && (
        <FidelityCard fidelity={props.summary.fidelity} />
      )}
    </Stack>
  );
}
