import type {
  ApiProxyRequestTrace,
  ApiProxyStatsSnapshot,
  ApiProxyTraceFile,
  ApiProxyTraceUsage,
} from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Database, FileText, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  clearApiProxyCache,
  getApiProxyCacheStats,
  getApiProxyRequestFile,
} from "../../../api/client";
import { JsonTreeView } from "../../components/JsonTreeView";
import { formatBytes } from "../../utils/models";
import { formatLocalDateTime, formatLocalHour } from "../../utils/time";
import { DetailBadge } from "./DetailBadge";

type StatsSectionProps = {
  snapshot: ApiProxyStatsSnapshot | undefined;
  traces: ApiProxyRequestTrace[];
  loading: boolean;
};

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${rate.toFixed(1)} t/s`;
}

const traceEndpointLabels: Record<string, string> = {
  "chat.completions": "Chat",
  completions: "Completions",
  embeddings: "Embeddings",
  responses: "Responses",
  messages: "Messages",
  "messages.count_tokens": "Count tokens",
};

function formatTraceEndpoint(endpoint: string): string {
  return traceEndpointLabels[endpoint] ?? endpoint;
}

function traceProtocolColor(protocol: string): string {
  return protocol === "anthropic" ? "violet" : "blue";
}

function traceStatusColor(trace: ApiProxyRequestTrace): string {
  if (trace.ok) {
    return "green";
  }
  return trace.errorCode === "client-abort" ? "yellow" : "red";
}

const CACHE_ORIGIN_COLORS: Record<
  NonNullable<ApiProxyRequestTrace["cacheOrigin"]>,
  string
> = {
  live: "teal",
  restored: "blue",
  fresh: "gray",
};

const CACHE_ORIGIN_HINTS: Record<
  NonNullable<ApiProxyRequestTrace["cacheOrigin"]>,
  string
> = {
  live: "prefix still resident in the slot",
  restored: "restored into the slot from the RAM prompt cache",
  fresh: "no cache reuse — prompt processed from scratch",
};

function routeTraceStepLine(step: ApiProxyRequestTrace["routeTrace"][number]) {
  if (step.kind === "enter-pipeline") {
    return `▸ ${step.pipelineName ?? step.pipelineId ?? "?"}`;
  }
  const label = step.nodeName || step.nodeId || step.kind;
  const port = step.port ? ` → ${step.port}` : "";
  const detail = step.detail ? ` (${step.detail})` : "";
  return `${step.kind}: ${label}${port}${detail}`;
}

function RouteTraceCell(props: { trace: ApiProxyRequestTrace }) {
  if (props.trace.routeTrace.length === 0) {
    return <>—</>;
  }
  return (
    <Tooltip
      multiline
      maw={480}
      withArrow
      label={
        <Stack gap={2}>
          {props.trace.routeTrace.map((step, index) => (
            <Text key={index} size="xs">
              {routeTraceStepLine(step)}
            </Text>
          ))}
        </Stack>
      }
    >
      <Text size="xs" style={{ cursor: "help" }}>
        {props.trace.routeTrace.length}
      </Text>
    </Tooltip>
  );
}

function SlotCell(props: { trace: ApiProxyRequestTrace }) {
  const { slotId, cacheOrigin } = props.trace;
  if (slotId === null) {
    return <>—</>;
  }
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs">{slotId}</Text>
      {cacheOrigin && (
        <Tooltip label={CACHE_ORIGIN_HINTS[cacheOrigin]}>
          <Badge
            size="xs"
            variant="light"
            color={CACHE_ORIGIN_COLORS[cacheOrigin]}
          >
            {cacheOrigin}
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

function TraceFilesCell(props: {
  trace: ApiProxyRequestTrace;
  onOpen: (file: ApiProxyTraceFile) => void;
}) {
  const files = props.trace.files;
  if (files.length === 0) {
    return <>—</>;
  }
  return (
    <Menu position="bottom-start" shadow="md" withinPortal>
      <Menu.Target>
        <Button
          size="compact-xs"
          variant="light"
          leftSection={<FileText size={12} />}
        >
          {files.length}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {files.map((file) => (
          <Menu.Item key={file.path} onClick={() => props.onOpen(file)}>
            <Stack gap={0}>
              <Text size="xs">{file.label || file.kind}</Text>
              <Text size="xs" c="dimmed">
                {file.name} · {formatBytes(file.bytes)}
              </Text>
            </Stack>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function TraceFileModal(props: {
  file: ApiProxyTraceFile | null;
  onClose: () => void;
}) {
  const path = props.file?.path ?? "";
  const fileQuery = useQuery({
    queryKey: ["api-proxy-request-file", path],
    queryFn: () => getApiProxyRequestFile(path),
    enabled: path !== "",
  });
  const record = fileQuery.data?.data;
  const [view, setView] = useState<"tree" | "raw">("tree");
  return (
    <Modal
      opened={props.file !== null}
      onClose={props.onClose}
      title={
        props.file
          ? `${props.file.label || props.file.kind} — ${props.file.name}`
          : ""
      }
      size="xl"
    >
      {fileQuery.isLoading && <Loader size="sm" />}
      {fileQuery.isError && (
        <Text size="sm" c="red">
          {(fileQuery.error as Error).message}
        </Text>
      )}
      {record && (
        <Stack gap="xs">
          <Group gap="xs" wrap="wrap" justify="space-between">
            <Group gap="xs" wrap="wrap">
              <Badge variant="light">{record.kind}</Badge>
              <Badge color="gray" variant="light">
                {record.protocol}
              </Badge>
              <Text size="xs" c="dimmed">
                {record.modelId} · {formatLocalDateTime(record.createdAt)}
              </Text>
            </Group>
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(value) => setView(value === "raw" ? "raw" : "tree")}
              data={[
                { value: "tree", label: "Tree" },
                { value: "raw", label: "Raw" },
              ]}
            />
          </Group>
          <ScrollArea.Autosize mah="65vh">
            {view === "tree" ? (
              <JsonTreeView value={record.data} />
            ) : (
              <Code block style={{ whiteSpace: "pre-wrap" }}>
                {JSON.stringify(record.data, null, 2)}
              </Code>
            )}
          </ScrollArea.Autosize>
        </Stack>
      )}
    </Modal>
  );
}

function TwoLineHeader(props: { title: string; hint: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" fw={700}>
        {props.title}
      </Text>
      <Text size="xs" fw={400} c="dimmed">
        {props.hint}
      </Text>
    </Stack>
  );
}

function TokensCell(props: { usage: ApiProxyTraceUsage | null }) {
  const usage = props.usage;
  if (!usage) {
    return <>—</>;
  }
  return <>{`${usage.promptTokens ?? "—"} / ${usage.completionTokens}`}</>;
}

function CacheCell(props: { usage: ApiProxyTraceUsage | null }) {
  const usage = props.usage;
  const cacheRead = usage?.cacheReadTokens ?? null;
  const cacheCreation = usage?.cacheCreationTokens ?? null;
  if (cacheRead === null && cacheCreation === null) {
    return <>—</>;
  }
  const input = usage?.promptTokens ?? null;
  const fresh =
    input === null
      ? null
      : Math.max(0, input - (cacheRead ?? 0) - (cacheCreation ?? 0));
  return <>{`${cacheRead ?? "—"} / ${fresh ?? "—"}`}</>;
}

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

const CACHE_BADGE_COLORS: Record<
  NonNullable<ApiProxyRequestTrace["cache"]>,
  string
> = {
  hit: "teal",
  coalesced: "cyan",
  store: "gray",
};

const CACHE_BADGE_HINTS: Record<
  NonNullable<ApiProxyRequestTrace["cache"]>,
  string
> = {
  hit: "served from the response cache (no upstream call)",
  coalesced: "joined an in-flight identical request (no upstream call)",
  store: "forwarded upstream and stored the response in the cache",
};

function CacheBadge(props: { trace: ApiProxyRequestTrace }) {
  const cache = props.trace.cache;
  const resumed = props.trace.resumed;
  if (!cache && !resumed) {
    return <>—</>;
  }
  return (
    <Group gap={4} wrap="nowrap">
      {resumed && (
        <Tooltip label="replayed from a llama-server stream session that survived a manager restart">
          <Badge size="xs" variant="light" color="violet">
            resumed
          </Badge>
        </Tooltip>
      )}
      {cache && (
        <Tooltip label={CACHE_BADGE_HINTS[cache]}>
          <Badge size="xs" variant="light" color={CACHE_BADGE_COLORS[cache]}>
            {cache}
          </Badge>
        </Tooltip>
      )}
    </Group>
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
  const [viewedFile, setViewedFile] = useState<ApiProxyTraceFile | null>(null);

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <BarChart3 size={18} />
            <Text fw={600}>Statistics</Text>
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
                value={formatRate(totals.ratePerSecond)}
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
                    <Table.Td>{formatRate(bucket.ratePerSecond)}</Table.Td>
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
            <Table.ScrollContainer minWidth={1180}>
              <Table
                striped
                withTableBorder
                fz="xs"
                styles={{ th: { verticalAlign: "top" } }}
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Time</Table.Th>
                    <Table.Th>Source</Table.Th>
                    <Table.Th>API</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Stream</Table.Th>
                    <Table.Th>Cache</Table.Th>
                    <Table.Th>Model</Table.Th>
                    <Table.Th>Target</Table.Th>
                    <Table.Th>Route</Table.Th>
                    <Table.Th>Files</Table.Th>
                    <Table.Th>Slot</Table.Th>
                    <Table.Th>Actions</Table.Th>
                    <Table.Th>
                      <TwoLineHeader title="Tokens" hint="in/out" />
                    </Table.Th>
                    <Table.Th>
                      <TwoLineHeader title="Cache" hint="read/new" />
                    </Table.Th>
                    <Table.Th>Rate</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>ms</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {props.traces.slice(0, 50).map((trace) => (
                    <Table.Tr key={trace.id}>
                      <Table.Td>{formatLocalDateTime(trace.at)}</Table.Td>
                      <Table.Td>
                        {trace.sourceName ? (
                          <Badge color="grape" variant="light">
                            {trace.sourceName}
                          </Badge>
                        ) : (
                          <Text size="xs" c="dimmed">
                            anonymous
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={traceProtocolColor(trace.protocol)}
                          variant="light"
                        >
                          {trace.translated
                            ? `${trace.protocol} → openai`
                            : trace.protocol}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={trace.routePath}>
                          <Text size="xs">
                            {formatTraceEndpoint(trace.endpoint)}
                          </Text>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td>
                        {trace.stream === null ? (
                          "—"
                        ) : (
                          <Badge
                            color={trace.stream ? "teal" : "gray"}
                            variant="light"
                          >
                            {trace.stream ? "stream" : "single"}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <CacheBadge trace={trace} />
                      </Table.Td>
                      <Table.Td>{trace.modelId || "—"}</Table.Td>
                      <Table.Td>{trace.targetName ?? "—"}</Table.Td>
                      <Table.Td>
                        <RouteTraceCell trace={trace} />
                      </Table.Td>
                      <Table.Td>
                        <TraceFilesCell trace={trace} onOpen={setViewedFile} />
                      </Table.Td>
                      <Table.Td>
                        <SlotCell trace={trace} />
                      </Table.Td>
                      <Table.Td>
                        {trace.schedulerActions.length > 0 ? (
                          <Tooltip
                            multiline
                            label={
                              trace.displacedTargetIds.length > 0
                                ? `${trace.schedulerActions.join(
                                    ", ",
                                  )} — displaced: ${trace.displacedTargetIds.join(
                                    ", ",
                                  )}`
                                : trace.schedulerActions.join(", ")
                            }
                          >
                            <Text size="xs">
                              {trace.schedulerActions.length}
                            </Text>
                          </Tooltip>
                        ) : (
                          "—"
                        )}
                      </Table.Td>
                      <Table.Td>
                        <TokensCell usage={trace.usage} />
                      </Table.Td>
                      <Table.Td>
                        <CacheCell usage={trace.usage} />
                      </Table.Td>
                      <Table.Td>
                        {trace.usage
                          ? formatRate(trace.usage.ratePerSecond)
                          : "—"}
                      </Table.Td>
                      <Table.Td>
                        <DetailBadge
                          color={traceStatusColor(trace)}
                          label={trace.status}
                          detail={trace.errorMessage}
                        />
                      </Table.Td>
                      <Table.Td>{trace.durationMs}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        )}
      </Stack>
      <TraceFileModal file={viewedFile} onClose={() => setViewedFile(null)} />
    </Paper>
  );
}
