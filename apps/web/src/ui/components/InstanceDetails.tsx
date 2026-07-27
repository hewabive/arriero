import {
  engineDescriptor,
  type Instance,
  type InstanceHealthSummary,
  type ProcessEvent,
} from "@arriero/core";
import {
  Accordion,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  getInstanceHealthSummary,
  getInstanceLogs,
  getInstancePreflight,
  getInstanceStatusSummary,
  getLlamaCapabilities,
  getLlamaProbe,
  getRuntime,
  instanceAction,
  instanceEventsUrl,
  llamaModelAction,
  llamaSlotAction,
  reloadLlamaModels,
} from "../../api/client";
import {
  canOpenLlamaWebUi,
  llamaServerWebUrl,
  llamaWebUiTooltip,
  openUrlInNewTab,
} from "../utils/instance-url";
import type { LaunchMonitor } from "../utils/launch";
import { formatLocalDateTime } from "../utils/time";
import {
  InstanceConfigDriftBadge,
  healthStatusColor,
  statusColor,
} from "./InstanceHealthBadge";
import {
  type RouterModelAction,
  type SlotActionInput,
  isStartupStatus,
  objectRecord,
  probeColor,
  propsSummary,
  slotRowsFromProbe,
  slotsRuntimeSummary,
  slowestProbe,
} from "./instance-details-helpers";
import { LaunchMonitorPanel } from "./InstanceDetailsLaunchMonitor";
import { MemoryLayoutPanel } from "./InstanceDetailsMemoryPanel";
import { SlotDetailsBlock, V1ModelsPanel } from "./InstanceDetailsModelsPanel";
import {
  ProbePill,
  PromptCachePanel,
  SectionLabel,
} from "./InstanceDetailsPanels";
import { LlamaCapabilitiesPanel } from "./LlamaCapabilitiesPanel";

export function InstanceDetails(props: {
  instance: Instance | null;
  health: InstanceHealthSummary | null | undefined;
  launchMonitor: LaunchMonitor | null;
  monitorNowMs: number;
  onLaunchStopped: (instance: Instance) => void;
}) {
  const [events, setEvents] = useState<ProcessEvent[]>([]);
  const [logSource, setLogSource] = useState<"filtered" | "raw">("filtered");
  const [openDetails, setOpenDetails] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const id = props.instance?.name;
  const engine = props.instance ? engineDescriptor(props.instance.kind) : null;
  const hasLlamaApi = engine?.nativeApi === "llama";

  const healthQuery = useQuery({
    queryKey: ["instance-health-summary", id],
    queryFn: () => getInstanceHealthSummary(id!),
    enabled: Boolean(id) && !props.health,
    refetchInterval: 3_000,
  });

  const runtimeQuery = useQuery({
    queryKey: ["instance-runtime", id],
    queryFn: () => getRuntime(id!),
    enabled: Boolean(id),
    refetchInterval: 2_500,
  });

  const preflightQuery = useQuery({
    queryKey: ["instance-preflight", id],
    queryFn: () => getInstancePreflight(id!),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });

  const llamaQuery = useQuery({
    queryKey: ["instance-llama", id],
    queryFn: () => getLlamaProbe(id!),
    enabled: Boolean(id) && hasLlamaApi,
    refetchInterval: 3_000,
  });

  const capabilityStatus =
    props.health?.status ?? props.instance?.status ?? null;
  const canProbeCapabilities = capabilityStatus
    ? ["ready", "degraded", "stale", "running"].includes(capabilityStatus)
    : false;

  const capabilitiesOpen = openDetails.includes("capabilities");
  const forceCapabilitiesRefreshRef = useRef(false);
  const capabilitiesQuery = useQuery({
    queryKey: ["instance-llama-capabilities", id],
    queryFn: () => {
      const force = forceCapabilitiesRefreshRef.current;
      forceCapabilitiesRefreshRef.current = false;
      return getLlamaCapabilities(id!, force);
    },
    enabled:
      Boolean(id) && hasLlamaApi && canProbeCapabilities && capabilitiesOpen,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const logsQuery = useQuery({
    queryKey: ["instance-logs", id, logSource],
    queryFn: () => getInstanceLogs(id!, 200, logSource),
    enabled: Boolean(id),
    refetchInterval: 3_000,
  });

  const statusSummaryQuery = useQuery({
    queryKey: ["instance-status-summary", id],
    queryFn: () => getInstanceStatusSummary(id!),
    enabled: Boolean(id),
    refetchInterval: 1_000,
  });

  useEffect(() => {
    setEvents([]);
    if (!id) {
      return undefined;
    }

    const eventSource = new EventSource(instanceEventsUrl(id));
    const append = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as ProcessEvent;
        setEvents((current) => [...current.slice(-199), parsed]);
      } catch {
        return;
      }
    };

    for (const eventName of ["ready", "status", "log", "exit", "error"]) {
      eventSource.addEventListener(eventName, append as EventListener);
    }

    return () => {
      eventSource.close();
    };
  }, [id]);

  const health = props.health ?? healthQuery.data?.data;
  const runtime = health?.runtime ?? runtimeQuery.data?.data;
  const preflight = health?.preflight ?? preflightQuery.data?.data;
  const llama = health?.llama ?? llamaQuery.data?.data;
  const logTail = logsQuery.data?.data;
  const statusSummary = health?.logSummary ?? statusSummaryQuery.data?.data;
  const errorLineSet = new Set(statusSummary?.errors ?? []);
  const warningLineSet = new Set(statusSummary?.warnings ?? []);
  const issueCount =
    (statusSummary?.errors.length ?? 0) + (statusSummary?.warnings.length ?? 0);
  const errorLineStyle = {
    borderLeft: "3px solid var(--mantine-color-red-6)",
    background: "var(--mantine-color-red-light)",
  };
  const warningLineStyle = {
    borderLeft: "3px solid var(--mantine-color-yellow-6)",
    background: "var(--mantine-color-yellow-light)",
  };
  const summary = useMemo(() => propsSummary(llama), [llama]);
  const showLaunchMonitor = Boolean(
    props.launchMonitor || isStartupStatus(health?.status),
  );

  const invalidateInstanceRuntime = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["instances"] }),
      queryClient.invalidateQueries({
        queryKey: ["instances-health-summary"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["instance-health-summary", id],
      }),
      queryClient.invalidateQueries({ queryKey: ["instance-runtime", id] }),
      queryClient.invalidateQueries({ queryKey: ["instance-llama", id] }),
      queryClient.invalidateQueries({
        queryKey: ["instance-llama-capabilities", id],
      }),
      queryClient.invalidateQueries({
        queryKey: ["instance-status-summary", id],
      }),
      queryClient.invalidateQueries({ queryKey: ["instance-logs", id] }),
    ]);
  };

  const monitorStopMutation = useMutation({
    mutationFn: () => instanceAction(id!, "stop"),
    onSuccess: async () => {
      if (props.instance) {
        props.onLaunchStopped(props.instance);
      }
      await invalidateInstanceRuntime();
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Stop failed",
        message: (error as Error).message,
      });
    },
  });

  const modelActionMutation = useMutation({
    mutationFn: (input: { model: string; action: RouterModelAction }) =>
      llamaModelAction(id!, input.action, input.model),
    onSuccess: async (result, variables) => {
      notifications.show({
        color: variables.action === "load" ? "green" : "yellow",
        title:
          variables.action === "load"
            ? "Model load requested"
            : "Model unload requested",
        message: result.data.fallback
          ? "llama-server used the autoload fallback for this build."
          : variables.model,
      });
      await invalidateInstanceRuntime();
    },
    onError: (error, variables) => {
      notifications.show({
        color: "red",
        title:
          variables.action === "load"
            ? "Model load failed"
            : "Model unload failed",
        message: (error as Error).message,
      });
    },
  });

  const slotActionMutation = useMutation({
    mutationFn: (input: SlotActionInput) =>
      llamaSlotAction(id!, input.action, input.slotId, {
        ...(input.model ? { model: input.model } : {}),
        ...(input.filename ? { filename: input.filename } : {}),
      }),
    onSuccess: async (result, variables) => {
      const body = result.data.response.body;
      const record = objectRecord(body);
      const count =
        record?.n_saved ?? record?.n_restored ?? record?.n_erased ?? null;
      notifications.show({
        color: variables.action === "erase" ? "yellow" : "green",
        title: `Slot ${variables.action} completed`,
        message:
          typeof count === "number"
            ? `slot ${variables.slotId}: ${count} token${count === 1 ? "" : "s"}`
            : `slot ${variables.slotId}`,
      });
      await invalidateInstanceRuntime();
    },
    onError: (error, variables) => {
      notifications.show({
        color: "red",
        title: `Slot ${variables.action} failed`,
        message: (error as Error).message,
      });
    },
  });

  const reloadModelsMutation = useMutation({
    mutationFn: () => reloadLlamaModels(id!),
    onSuccess: async () => {
      notifications.show({
        color: "blue",
        title: "Model list reloaded",
        message: "llama-server refreshed router model metadata.",
      });
      await invalidateInstanceRuntime();
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Model reload failed",
        message: (error as Error).message,
      });
    },
  });

  if (!props.instance) {
    return (
      <Paper withBorder p="lg" radius="sm">
        <Text c="dimmed" ta="center">
          Select an instance to inspect runtime state
        </Text>
      </Paper>
    );
  }

  const webUiUrl = llamaServerWebUrl(props.instance);
  const webUiDisabled = !canOpenLlamaWebUi(health, webUiUrl);
  const rootSlotRows = slotRowsFromProbe(llama?.slots);
  const slowestLlamaProbe = slowestProbe([
    ["health", llama?.health],
    ["props", llama?.props],
    ["slots", llama?.slots],
    ["v1/models", llama?.models],
  ]);
  const pendingSlotAction = slotActionMutation.isPending
    ? (slotActionMutation.variables ?? null)
    : null;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>{props.instance.name}</Title>
            <Text c="dimmed" size="sm">
              {props.instance.binaryPath}
            </Text>
          </div>
          <Group gap="xs">
            {hasLlamaApi && (
              <Tooltip label={llamaWebUiTooltip(health, webUiUrl)}>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<ExternalLink size={14} />}
                  disabled={webUiDisabled}
                  onClick={() => {
                    if (webUiUrl) {
                      openUrlInNewTab(webUiUrl);
                    }
                  }}
                >
                  Web UI
                </Button>
              </Tooltip>
            )}
            <Tooltip
              label={health?.reason ?? "Health summary is loading"}
              withArrow
            >
              <Badge
                color={
                  health
                    ? healthStatusColor(health.status)
                    : statusColor(runtime?.status ?? props.instance.status)
                }
                variant="light"
              >
                {health?.status ?? runtime?.status ?? props.instance.status}
              </Badge>
            </Tooltip>
            <InstanceConfigDriftBadge health={health} />
          </Group>
        </Group>

        <Paper withBorder p="sm" radius="sm">
          <Stack gap={4}>
            <Text fw={600} size="sm">
              Health
            </Text>
            <Text
              c={
                health?.status === "error" || health?.status === "invalid"
                  ? "red"
                  : "dimmed"
              }
              size="sm"
            >
              {health?.reason ??
                "Checking process, preflight, logs and HTTP endpoints..."}
            </Text>
          </Stack>
          {hasLlamaApi && (
            <Group gap="xs" mt="sm">
              <ProbePill title="health" probe={llama?.health} />
              <ProbePill title="props" probe={llama?.props} />
              <ProbePill title="slots" probe={llama?.slots} />
              <ProbePill title="v1/models" probe={llama?.models} />
            </Group>
          )}
          {(health || (hasLlamaApi && slowestLlamaProbe)) && (
            <Text c="dimmed" size="xs" mt={6}>
              {health && `Checked: ${formatLocalDateTime(health.checkedAt)}`}
              {health && hasLlamaApi && slowestLlamaProbe && " · "}
              {hasLlamaApi &&
                slowestLlamaProbe &&
                `Slowest probe: ${slowestLlamaProbe.label} ${slowestLlamaProbe.latencyMs} ms`}
            </Text>
          )}
        </Paper>

        <SectionLabel>Memory &amp; cache</SectionLabel>
        <MemoryLayoutPanel
          layout={statusSummary?.memoryLayout}
          declared={props.instance?.memory}
        />

        {hasLlamaApi && rootSlotRows.length > 0 && (
          <Paper withBorder p="sm" radius="sm">
            <Group justify="space-between" mb="xs">
              <Stack gap={2}>
                <Text fw={600} size="sm">
                  Slots
                </Text>
                <Text c="dimmed" size="xs">
                  Live slot cache state from `GET /slots`.
                </Text>
              </Stack>
              <Badge color={probeColor(llama?.slots)} variant="light">
                {slotsRuntimeSummary(llama?.slots)}
              </Badge>
            </Group>
            <SlotDetailsBlock
              rows={rootSlotRows}
              model={null}
              pendingAction={pendingSlotAction}
              onSlotAction={(input) => slotActionMutation.mutate(input)}
            />
          </Paper>
        )}

        <PromptCachePanel state={health?.promptCache ?? null} />

        {showLaunchMonitor && (
          <LaunchMonitorPanel
            health={health}
            runtime={runtime}
            logTail={logTail}
            statusSummary={statusSummary}
            monitor={props.launchMonitor}
            nowMs={props.monitorNowMs}
            onStop={() => monitorStopMutation.mutate()}
            stopping={monitorStopMutation.isPending}
          />
        )}

        {hasLlamaApi && (
          <>
            <SectionLabel>Models</SectionLabel>
            <V1ModelsPanel
              probe={llama?.models}
              modelDiagnostics={llama?.modelDiagnostics ?? {}}
              statusSummary={statusSummary}
              onReload={() => reloadModelsMutation.mutate()}
              reloadPending={reloadModelsMutation.isPending}
              onModelAction={(model, action) =>
                modelActionMutation.mutate({ model, action })
              }
              pendingAction={
                modelActionMutation.isPending
                  ? (modelActionMutation.variables ?? null)
                  : null
              }
              onSlotAction={(input) => slotActionMutation.mutate(input)}
              pendingSlotAction={pendingSlotAction}
            />
          </>
        )}

        <SectionLabel>Details</SectionLabel>
        <Accordion
          multiple
          variant="contained"
          radius="sm"
          value={openDetails}
          onChange={setOpenDetails}
        >
          <Accordion.Item value="runtime">
            <Accordion.Control>Runtime &amp; paths</Accordion.Control>
            <Accordion.Panel>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                <Stack gap={4}>
                  <Text fw={600} size="sm">
                    Runtime
                  </Text>
                  <Text size="sm">PID: {runtime?.pid ?? "-"}</Text>
                  <Text size="sm">
                    Started: {formatLocalDateTime(runtime?.startedAt)}
                  </Text>
                  <Text size="sm">Exit code: {runtime?.exitCode ?? "-"}</Text>
                  <Text size="sm" lineClamp={2}>
                    Log: {runtime?.logPath ?? "-"}
                  </Text>
                  <Text size="sm" lineClamp={2}>
                    Raw log: {runtime?.rawLogPath ?? "-"}
                  </Text>
                </Stack>
                <Stack gap={4}>
                  <Text fw={600} size="sm">
                    {engine?.displayName ?? "server"}
                  </Text>
                  <Text size="sm">Base URL: {llama?.baseUrl || "-"}</Text>
                  {summary.map(([label, value]) => (
                    <Text key={label} size="sm" lineClamp={2}>
                      {label}: {String(value)}
                    </Text>
                  ))}
                </Stack>
              </SimpleGrid>
            </Accordion.Panel>
          </Accordion.Item>

          {hasLlamaApi && (
            <Accordion.Item value="capabilities">
              <Accordion.Control>Capabilities</Accordion.Control>
              <Accordion.Panel>
                <LlamaCapabilitiesPanel
                  data={
                    canProbeCapabilities
                      ? (capabilitiesQuery.data?.data ?? null)
                      : null
                  }
                  disabledReason={
                    canProbeCapabilities
                      ? null
                      : `Start the instance to probe live ${engine?.displayName ?? "server"} endpoints.`
                  }
                  loading={capabilitiesQuery.isFetching}
                  error={
                    canProbeCapabilities
                      ? ((capabilitiesQuery.error as Error | null)?.message ??
                        null)
                      : null
                  }
                  onRefresh={() => {
                    forceCapabilitiesRefreshRef.current = true;
                    void capabilitiesQuery.refetch();
                  }}
                />
              </Accordion.Panel>
            </Accordion.Item>
          )}

          <Accordion.Item value="preflight">
            <Accordion.Control>
              <Group
                justify="space-between"
                wrap="nowrap"
                pr="sm"
                style={{ flexGrow: 1 }}
              >
                <Text fw={600} size="sm">
                  Preflight
                </Text>
                <Badge
                  color={preflight ? (preflight.ok ? "green" : "red") : "gray"}
                  variant="light"
                >
                  {preflight
                    ? preflight.ok
                      ? "ok"
                      : "needs attention"
                    : "checking"}
                </Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap={4}>
                {(preflight?.issues ?? []).map((issue, index) => (
                  <Text
                    key={`${issue.field}-${index}`}
                    c={issue.level === "error" ? "red" : "yellow"}
                    size="xs"
                  >
                    {issue.field}: {issue.message}
                  </Text>
                ))}
                {preflight && preflight.issues.length === 0 && (
                  <Text c="dimmed" size="xs">
                    Binary, working directory and known path arguments look
                    valid.
                  </Text>
                )}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>

          <Accordion.Item value="parsed-status">
            <Accordion.Control>
              <Group
                justify="space-between"
                wrap="nowrap"
                pr="sm"
                style={{ flexGrow: 1 }}
              >
                <Text fw={600} size="sm">
                  Parsed status
                </Text>
                <Badge
                  color={statusSummary?.ready ? "green" : "gray"}
                  variant="light"
                >
                  {statusSummary?.ready ? "ready" : "not ready"}
                </Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                <Text size="sm" lineClamp={1}>
                  URL: {statusSummary?.listeningUrl ?? llama?.baseUrl ?? "-"}
                </Text>
                <Text size="sm" lineClamp={1}>
                  Model:{" "}
                  {statusSummary?.modelAlias ?? statusSummary?.modelPath ?? "-"}
                </Text>
                <Text size="sm">
                  Context: {statusSummary?.contextSize ?? "-"}
                </Text>
                <Text size="sm">Slots: {statusSummary?.slots ?? "-"}</Text>
                <Text size="sm" lineClamp={1}>
                  GPU/offload: {statusSummary?.gpuLayers ?? "-"}
                </Text>
                <Text size="sm">
                  Warnings: {statusSummary?.warnings.length ?? 0}
                </Text>
              </SimpleGrid>
              {Boolean(
                (statusSummary?.errors.length ?? 0) +
                (statusSummary?.warnings.length ?? 0) +
                (statusSummary?.notices.length ?? 0),
              ) && (
                <Stack gap={4} mt="xs">
                  {(statusSummary?.errors ?? [])
                    .slice(-3)
                    .map((line, index) => (
                      <Text
                        key={`error-${index}`}
                        c="red"
                        size="xs"
                        lineClamp={2}
                      >
                        {line}
                      </Text>
                    ))}
                  {(statusSummary?.warnings ?? [])
                    .slice(-4)
                    .map((line, index) => (
                      <Text
                        key={`warning-${index}`}
                        c="yellow"
                        size="xs"
                        lineClamp={2}
                      >
                        {line}
                      </Text>
                    ))}
                  {(statusSummary?.notices ?? [])
                    .slice(-4)
                    .map((line, index) => (
                      <Text
                        key={`notice-${index}`}
                        c="dimmed"
                        size="xs"
                        lineClamp={2}
                      >
                        {line}
                      </Text>
                    ))}
                </Stack>
              )}
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>

        <SectionLabel>Logs &amp; events</SectionLabel>
        <Tabs defaultValue="log">
          <Tabs.List>
            <Tabs.Tab
              value="log"
              rightSection={
                <Badge variant="light" size="sm">
                  {logTail?.lines.length ?? 0}
                </Badge>
              }
            >
              Log
            </Tabs.Tab>
            <Tabs.Tab
              value="issues"
              rightSection={
                <Badge
                  variant="light"
                  size="sm"
                  color={issueCount > 0 ? "red" : "gray"}
                >
                  {issueCount}
                </Badge>
              }
            >
              Issues
            </Tabs.Tab>
            <Tabs.Tab
              value="events"
              rightSection={
                <Badge variant="light" size="sm">
                  {events.length}
                </Badge>
              }
            >
              Events
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="log" pt="xs">
            <Group justify="space-between" mb="xs" wrap="nowrap">
              <Text c="dimmed" size="xs" lineClamp={1}>
                {logTail?.logPath ?? "No log file yet"}
              </Text>
              <SegmentedControl
                size="xs"
                value={logSource}
                data={[
                  { value: "filtered", label: "Filtered" },
                  { value: "raw", label: "Raw" },
                ]}
                onChange={(value) =>
                  setLogSource(value === "raw" ? "raw" : "filtered")
                }
              />
            </Group>
            <ScrollArea h={260} type="auto" offsetScrollbars>
              <Stack gap={4}>
                {logTail?.lines.map((line, index) => {
                  const trimmed = line.trim();
                  const lineStyle = errorLineSet.has(trimmed)
                    ? errorLineStyle
                    : warningLineSet.has(trimmed)
                      ? warningLineStyle
                      : undefined;
                  return (
                    <Code
                      key={`${logTail.logPath}-${index}`}
                      block
                      className="code-wrap"
                      style={lineStyle}
                    >
                      {line}
                    </Code>
                  );
                })}
                {(!logTail || logTail.lines.length === 0) && (
                  <Text c="dimmed" size="sm" ta="center" py="lg">
                    No log history yet
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Tabs.Panel>

          <Tabs.Panel value="issues" pt="xs">
            <ScrollArea h={260} type="auto" offsetScrollbars>
              <Stack gap={4}>
                {(statusSummary?.errors ?? []).map((line, index) => (
                  <Code
                    key={`issue-error-${index}`}
                    block
                    className="code-wrap"
                    style={errorLineStyle}
                  >
                    {line}
                  </Code>
                ))}
                {(statusSummary?.warnings ?? []).map((line, index) => (
                  <Code
                    key={`issue-warning-${index}`}
                    block
                    className="code-wrap"
                    style={warningLineStyle}
                  >
                    {line}
                  </Code>
                ))}
                {issueCount === 0 && (
                  <Text c="dimmed" size="sm" ta="center" py="lg">
                    No errors or warnings in the log
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Tabs.Panel>

          <Tabs.Panel value="events" pt="xs">
            <ScrollArea h={260} type="auto" offsetScrollbars>
              <Stack gap={4}>
                {events.map((event, index) => (
                  <Code
                    key={`${event.timestamp}-${index}`}
                    block
                    className="code-wrap"
                  >
                    {formatLocalDateTime(event.timestamp)} [{event.type}]{" "}
                    {event.message.trimEnd()}
                  </Code>
                ))}
                {events.length === 0 && (
                  <Text c="dimmed" size="sm" ta="center" py="lg">
                    No runtime events yet
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Paper>
  );
}
