import {
  isBenchmarkClassSupported,
  type BenchmarkTargetSnapshot,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { countLabel } from "../utils/plural";

import {
  formatDurationMs,
  formatPercent,
  formatRate,
} from "./benchmark-format";
import { BenchmarkHeadline } from "./BenchmarkHeadline";
import { BenchmarkTimeline } from "./BenchmarkTimeline";
import type { BenchmarkViewController } from "./use-benchmark-view";

function numaLabel(numa: NonNullable<BenchmarkTargetSnapshot["numa"]>): string {
  return numa.mode === "bind"
    ? `bind · node ${numa.node}`
    : `interleave · nodes ${numa.nodes.join(", ")}`;
}

function KeyValueTable({ entries }: { entries: Array<[string, string]> }) {
  return (
    <Table.ScrollContainer minWidth={320}>
      <Table striped withTableBorder>
        <Table.Tbody>
          {entries.map(([key, value]) => (
            <Table.Tr key={key}>
              <Table.Td>
                <Code>{key}</Code>
              </Table.Td>
              <Table.Td style={{ wordBreak: "break-all" }}>{value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function BenchmarkLaunchConfig({
  snapshot,
}: {
  snapshot: BenchmarkTargetSnapshot;
}) {
  const [open, setOpen] = useState(false);
  const argEntries = Object.entries(snapshot.args).map(
    ([key, value]): [string, string] => [key, String(value)],
  );
  const envEntries = Object.entries(snapshot.env);
  const hasContent =
    argEntries.length > 0 ||
    envEntries.length > 0 ||
    snapshot.numa !== null ||
    snapshot.rpcWorkers.length > 0 ||
    snapshot.launchCliArgs !== null ||
    snapshot.binaryPath !== null;
  if (!hasContent) {
    return null;
  }
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Title order={4}>Launch configuration</Title>
        <Button size="xs" variant="subtle" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      </Group>
      <Collapse in={open}>
        <Stack gap="sm">
          {(snapshot.binaryPath !== null || snapshot.numa !== null) && (
            <Group gap="xs" wrap="wrap">
              {snapshot.numa !== null && (
                <Badge variant="light" color="teal">
                  numa {numaLabel(snapshot.numa)}
                </Badge>
              )}
              {snapshot.binaryPath !== null && (
                <Code style={{ wordBreak: "break-all" }}>
                  {snapshot.binaryPath}
                </Code>
              )}
            </Group>
          )}
          {argEntries.length > 0 && (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Arguments
              </Text>
              <KeyValueTable entries={argEntries} />
            </Stack>
          )}
          {envEntries.length > 0 && (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Environment
              </Text>
              <KeyValueTable entries={envEntries} />
            </Stack>
          )}
          {snapshot.rpcWorkers.length > 0 && (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                RPC workers
              </Text>
              <Group gap="xs" wrap="wrap">
                {snapshot.rpcWorkers.map((worker, index) => (
                  <Badge key={index} variant="light">
                    {worker.nodeId
                      ? `${worker.nodeId}:${worker.instanceName}`
                      : worker.instanceName}
                  </Badge>
                ))}
              </Group>
            </Stack>
          )}
          {snapshot.launchCliArgs !== null && (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Launch argv
              </Text>
              <Code block style={{ wordBreak: "break-all" }}>
                {snapshot.launchCliArgs.join(" ")}
              </Code>
            </Stack>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
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
              {run.snapshot?.buildInfo ? ` · ${run.snapshot.buildInfo}` : ""}
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
                      draft acceptance {formatPercent(summary.acceptanceRate)}
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

        {fm.result && (
          <BenchmarkTimeline
            result={fm.result}
            baseline={summary?.headline?.soloDecodeTokensPerSecond ?? null}
          />
        )}
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
                        <Table.Td>{formatPercent(entry.wallShare)}</Table.Td>
                        <Table.Td>
                          {(entry.wallMs / 1000).toFixed(2)} s
                        </Table.Td>
                        <Table.Td>
                          {supported
                            ? formatRate(entry.decodeTokensPerSecond)
                            : "—"}
                        </Table.Td>
                        <Table.Td>
                          {supported
                            ? formatRate(entry.perRequestDecodeTokensPerSecond)
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
                        {formatRate(topic.soloDecodeTokensPerSecond)}
                      </Table.Td>
                      <Table.Td>
                        {formatRate(topic.contendedDecodeTokensPerSecond)}
                      </Table.Td>
                      <Table.Td>{formatPercent(topic.acceptanceRate)}</Table.Td>
                      <Table.Td>
                        {formatDurationMs(topic.averageTimeToFirstTokenMs)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        )}

        {run.snapshot && <BenchmarkLaunchConfig snapshot={run.snapshot} />}
      </Stack>
    </Paper>
  );
}
