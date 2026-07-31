import type {
  ApiProxyRequestTrace,
  ApiProxyTraceFile,
  ApiProxyTraceUsage,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Braces, FileText } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { getApiProxyRequestFile } from "../../api/client";
import { JsonTreeView } from "../components/JsonTreeView";
import { formatBytes } from "../utils/models";
import { formatLocalDateTime } from "../utils/time";
import { DetailBadge } from "./sections/DetailBadge";

export function formatTraceRate(rate: number | null): string {
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

export function formatTraceEndpoint(endpoint: string): string {
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

function JsonViewPanel(props: { header: ReactNode; value: unknown }) {
  const [view, setView] = useState<"tree" | "raw">("tree");
  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap" justify="space-between">
        <Group gap="xs" wrap="wrap">
          {props.header}
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
          <JsonTreeView value={props.value} />
        ) : (
          <Code block style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(props.value, null, 2)}
          </Code>
        )}
      </ScrollArea.Autosize>
    </Stack>
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
        <JsonViewPanel
          value={record.data}
          header={
            <>
              <Badge variant="light">{record.kind}</Badge>
              <Badge color="gray" variant="light">
                {record.protocol}
              </Badge>
              <Text size="xs" c="dimmed">
                {record.modelId} · {formatLocalDateTime(record.createdAt)}
              </Text>
            </>
          }
        />
      )}
    </Modal>
  );
}

function TraceInspectModal(props: {
  trace: ApiProxyRequestTrace | null;
  onClose: () => void;
}) {
  const trace = props.trace;
  return (
    <Modal
      opened={trace !== null}
      onClose={props.onClose}
      title={trace ? `Trace ${trace.id}` : ""}
      size="xl"
    >
      {trace && (
        <JsonViewPanel
          value={trace}
          header={
            <>
              <Badge color={traceProtocolColor(trace.protocol)} variant="light">
                {trace.protocol}
              </Badge>
              <Badge color={traceStatusColor(trace)} variant="light">
                {trace.status}
              </Badge>
              <Text size="xs" c="dimmed">
                {trace.modelId || "—"} · {formatLocalDateTime(trace.at)}
              </Text>
            </>
          }
        />
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

const TraceRow = memo(function TraceRow(props: {
  trace: ApiProxyRequestTrace;
  onOpenFile: (file: ApiProxyTraceFile) => void;
  onInspect: (trace: ApiProxyRequestTrace) => void;
}) {
  const trace = props.trace;
  return (
    <Table.Tr>
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
        <Badge color={traceProtocolColor(trace.protocol)} variant="light">
          {trace.translated ? `${trace.protocol} → openai` : trace.protocol}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Tooltip label={trace.routePath}>
          <Text size="xs">{formatTraceEndpoint(trace.endpoint)}</Text>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        {trace.stream === null ? (
          "—"
        ) : (
          <Badge color={trace.stream ? "teal" : "gray"} variant="light">
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
        <TraceFilesCell trace={trace} onOpen={props.onOpenFile} />
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
                  )} — displaced: ${trace.displacedTargetIds.join(", ")}`
                : trace.schedulerActions.join(", ")
            }
          >
            <Text size="xs">{trace.schedulerActions.length}</Text>
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
        {trace.usage ? formatTraceRate(trace.usage.ratePerSecond) : "—"}
      </Table.Td>
      <Table.Td>
        <DetailBadge
          color={traceStatusColor(trace)}
          label={trace.status}
          detail={trace.errorMessage}
        />
      </Table.Td>
      <Table.Td>{trace.durationMs}</Table.Td>
      <Table.Td>
        <Tooltip label="Inspect full trace">
          <ActionIcon
            size="sm"
            variant="subtle"
            onClick={() => props.onInspect(trace)}
          >
            <Braces size={14} />
          </ActionIcon>
        </Tooltip>
      </Table.Td>
    </Table.Tr>
  );
});

export function TracesTable(props: { traces: ApiProxyRequestTrace[] }) {
  const [viewedFile, setViewedFile] = useState<ApiProxyTraceFile | null>(null);
  const [inspected, setInspected] = useState<ApiProxyRequestTrace | null>(null);

  return (
    <>
      <Table.ScrollContainer minWidth={1220}>
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
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {props.traces.map((trace) => (
              <TraceRow
                key={trace.id}
                trace={trace}
                onOpenFile={setViewedFile}
                onInspect={setInspected}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <TraceFileModal file={viewedFile} onClose={() => setViewedFile(null)} />
      <TraceInspectModal trace={inspected} onClose={() => setInspected(null)} />
    </>
  );
}
