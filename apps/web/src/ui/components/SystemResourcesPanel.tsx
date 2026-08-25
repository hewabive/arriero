import {
  SYSTEM_METRICS_WINDOWS,
  type EventLoopReport,
  type EventLoopStall,
  type SystemAccelerator,
  type SystemAcceleratorEcc,
  type SystemAcceleratorPcie,
  type SystemAcceleratorRecoveryAction,
  type SystemAcceleratorThrottleReason,
  type SystemDiskDevice,
  type SystemMetricsSample,
  type SystemMetricsWindow,
  type SystemResources,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Divider,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMemo, type ReactNode } from "react";

import { formatBytesPerSecond } from "../utils/models";
import { formatAcceleratorName } from "../utils/pools";
import { formatLocalClock } from "../utils/time";
import { formatDurationMs } from "../views/benchmark-format";
import { MetricCard } from "./MetricCard";
import {
  MetricChart,
  MetricHoverProvider,
  type MetricSeries,
} from "./MetricChart";
import { countLabel } from "../utils/plural";

const bytesFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
});

const DEVICE_CHART_HEIGHT = 92;

function formatBytes(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "-";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${bytesFormatter.format(size)} ${units[unitIndex]}`;
}

function formatPercent(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "-";
  }
  return `${Math.round(value)}%`;
}

function formatMs(value: number | null | undefined) {
  return formatDurationMs(value ?? null);
}

function stallVerdictLabel(stall: EventLoopStall) {
  const signals = stall.signals;
  if (stall.verdict === "starved") {
    return `starved by the host${signals ? ` (run delay ${formatMs(signals.runDelayMs)})` : ""}`;
  }
  if (stall.verdict === "self-cpu") {
    return `own CPU${signals ? ` (${formatMs(signals.cpuMs)})` : ""}`;
  }
  if (stall.verdict === "self-wait") {
    return "own sync wait";
  }
  if (stall.verdict === "paging") {
    return `paging${signals ? ` (${countLabel(signals.majorPageFaults, "major fault")})` : ""}`;
  }
  return "unattributed";
}

function stallSummary(stall: EventLoopStall) {
  const at = formatLocalClock(stall.detectedAt);
  const culprits = stall.culprits
    .map((culprit) => `${culprit.label} (${formatMs(culprit.durationMs)})`)
    .join(", ");
  return `${at} · ${formatMs(stall.durationMs)} · ${stallVerdictLabel(stall)}${culprits ? ` · ${culprits}` : ""}`;
}

function diskTypeLabel(type: SystemDiskDevice["type"]) {
  if (type === "ssd") return "SSD/NVMe";
  if (type === "hdd") return "HDD";
  return "disk";
}

function ioPressureColor(avg10: number) {
  if (avg10 >= 50) return "red";
  if (avg10 >= 20) return "orange";
  if (avg10 >= 5) return "yellow";
  return "gray";
}

function loadColor(usedRatio: number) {
  if (usedRatio >= 0.9) return "red";
  if (usedRatio >= 0.75) return "orange";
  return "green";
}

function usedValue(total: number | null, free: number | null) {
  return total === null || free === null ? null : Math.max(0, total - free);
}

function usedPercent(total: number | null, free: number | null) {
  const used = usedValue(total, free);
  return used === null || total === null || total === 0
    ? null
    : Math.min(100, (used / total) * 100);
}

type AcceleratorHealthBadge = {
  key: string;
  label: string;
  color: "red" | "yellow";
  detail: string;
};

function eccBadgeInfo(
  ecc: SystemAcceleratorEcc | undefined,
): Omit<AcceleratorHealthBadge, "key"> | null {
  if (!ecc) {
    return null;
  }
  const rows = ecc.remappedRows;
  const pages = ecc.retiredPages;
  const actionRequired =
    rows?.pending === true || rows?.failure === true || pages?.pending === true;
  const remappedCount = rows ? rows.corrected + rows.uncorrected : 0;
  const retiredCount = pages
    ? (pages.corrected ?? 0) + (pages.uncorrected ?? 0)
    : 0;
  const hasHistory =
    (ecc.uncorrected ?? 0) > 0 || remappedCount > 0 || retiredCount > 0;
  if (!actionRequired && !hasHistory) {
    return null;
  }
  const parts: string[] = [];
  if (ecc.uncorrected !== undefined) {
    parts.push(`Uncorrectable ${ecc.uncorrected}`);
  }
  if (ecc.corrected !== undefined) {
    parts.push(`Correctable ${ecc.corrected}`);
  }
  if (rows) {
    const rowState = [
      rows.pending ? "pending GPU reset" : null,
      rows.failure ? "remap failure" : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
    parts.push(
      `Remapped rows ${remappedCount}${rowState ? ` (${rowState})` : ""}`,
    );
  }
  if (pages) {
    parts.push(
      `Retired pages ${retiredCount}${pages.pending === true ? " (retirement pending)" : ""}`,
    );
  }
  return {
    label: actionRequired ? "ECC action required" : "ECC history",
    color: actionRequired ? "red" : "yellow",
    detail: parts.join(" · "),
  };
}

const RECOVERY_ACTION_LABELS: Partial<
  Record<SystemAcceleratorRecoveryAction, string>
> = {
  "gpu-reset": "Reset required",
  "node-reboot": "Reboot required",
  "drain-p2p": "Drain P2P required",
  "drain-and-reset": "Drain + reset required",
  "recover-imex-domain": "IMEX recovery required",
};

const THROTTLE_REASON_LABELS: Record<SystemAcceleratorThrottleReason, string> =
  {
    "hw-slowdown": "HW slowdown",
    "hw-thermal": "HW thermal slowdown",
    "hw-power-brake": "HW power brake",
    "sw-thermal": "SW thermal slowdown",
    "sw-power-cap": "SW power cap",
  };

const CRITICAL_THROTTLE_REASONS: ReadonlySet<SystemAcceleratorThrottleReason> =
  new Set(["hw-slowdown", "hw-thermal", "hw-power-brake"]);

function throttleBadgeInfo(
  reasons: SystemAcceleratorThrottleReason[] | undefined,
): Omit<AcceleratorHealthBadge, "key"> | null {
  if (!reasons || reasons.length === 0) {
    return null;
  }
  const alerting = reasons.filter((reason) => reason !== "sw-power-cap");
  if (alerting.length === 0) {
    return null;
  }
  const critical = alerting.some((reason) =>
    CRITICAL_THROTTLE_REASONS.has(reason),
  );
  return {
    label: critical ? "HW throttling" : "Thermal throttling",
    color: critical ? "red" : "yellow",
    detail: reasons.map((reason) => THROTTLE_REASON_LABELS[reason]).join(" · "),
  };
}

function pcieLinkLabel(
  generation: number | undefined,
  width: number | undefined,
) {
  return [
    width === undefined ? null : `x${width}`,
    generation === undefined ? null : `gen${generation}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function pcieBadgeInfo(
  pcie: SystemAcceleratorPcie | undefined,
): Omit<AcceleratorHealthBadge, "key"> | null {
  if (!pcie) {
    return null;
  }
  const widthDegraded =
    pcie.currentWidth !== undefined &&
    pcie.maxWidth !== undefined &&
    pcie.currentWidth < pcie.maxWidth;
  if (!widthDegraded && (pcie.replayCounter ?? 0) <= 0) {
    return null;
  }
  const parts: string[] = [];
  const current = pcieLinkLabel(pcie.currentGeneration, pcie.currentWidth);
  const max = pcieLinkLabel(pcie.maxGeneration, pcie.maxWidth);
  if (current) {
    parts.push(`Link ${current}${max ? ` (max ${max})` : ""}`);
  }
  if (pcie.replayCounter !== undefined) {
    parts.push(`Replay counter ${pcie.replayCounter}`);
  }
  return {
    label: widthDegraded
      ? `PCIe x${pcie.currentWidth} (max x${pcie.maxWidth})`
      : "PCIe replays",
    color: "yellow",
    detail: parts.join(" · "),
  };
}

function acceleratorHealthBadges(
  accelerator: SystemAccelerator,
): AcceleratorHealthBadge[] {
  const badges: AcceleratorHealthBadge[] = [];
  const recoveryLabel = accelerator.recoveryAction
    ? RECOVERY_ACTION_LABELS[accelerator.recoveryAction]
    : undefined;
  if (recoveryLabel) {
    badges.push({
      key: "recovery",
      label: recoveryLabel,
      color: "red",
      detail: `GPU recovery action: ${recoveryLabel}. Set by the driver after a hardware error; the GPU cannot serve CUDA work until the action is completed.`,
    });
  }
  const ecc = eccBadgeInfo(accelerator.ecc);
  if (ecc) {
    badges.push({ key: "ecc", ...ecc });
  }
  const throttle = throttleBadgeInfo(accelerator.throttleReasons);
  if (throttle) {
    badges.push({ key: "throttle", ...throttle });
  }
  const pcie = pcieBadgeInfo(accelerator.pcie);
  if (pcie) {
    badges.push({ key: "pcie", ...pcie });
  }
  return badges;
}

function ResourceMetric(props: { label: string; value: string }) {
  return (
    <div>
      <Text c="dimmed" size="xs" tt="uppercase">
        {props.label}
      </Text>
      <Text fw={700}>{props.value}</Text>
    </div>
  );
}

function SectionHeading(props: {
  title: string;
  badges?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <Group justify="space-between" gap="xs" wrap="wrap">
      <Group gap="xs">
        <Text fw={600} size="sm">
          {props.title}
        </Text>
        {props.badges}
      </Group>
      {props.meta}
    </Group>
  );
}

const WINDOW_LABELS: Record<SystemMetricsWindow, string> = {
  live: "5 min",
  hour: "1 hour",
  day: "24 hours",
  month: "30 days",
};

const WINDOW_OPTIONS = SYSTEM_METRICS_WINDOWS.map((value) => ({
  value,
  label: WINDOW_LABELS[value],
}));

function seriesFrom(
  samples: SystemMetricsSample[],
  pick: (sample: SystemMetricsSample) => number | null | undefined,
): (number | null)[] {
  return samples.map((sample) => pick(sample) ?? null);
}

export function SystemResourcesPanel(props: {
  resources: SystemResources | undefined;
  eventLoop?: EventLoopReport | undefined;
  samples: SystemMetricsSample[];
  windowMs: number;
  intervalMs: number;
  window: SystemMetricsWindow;
  onWindowChange: (window: SystemMetricsWindow) => void;
  fetching?: boolean;
}) {
  const memory = props.resources?.memory;
  const cpu = props.resources?.cpu ?? null;
  const accelerators = props.resources?.accelerators ?? [];
  const disk = props.resources?.disk ?? null;
  const storage = props.resources?.storage ?? null;
  const rdma = storage?.rdma ?? null;
  const network = props.resources?.network ?? null;
  const samples = props.samples;
  const latest = samples[samples.length - 1] ?? null;
  const axis = useMemo(
    () => ({
      times: samples.map((sample) => sample.at),
      windowMs: props.windowMs,
      intervalMs: props.intervalMs,
    }),
    [samples, props.windowMs, props.intervalMs],
  );

  return (
    <MetricHoverProvider>
      <Paper withBorder p="md" radius="sm">
        <Stack gap="md">
          <Group justify="flex-end" gap="xs">
            <SegmentedControl
              size="xs"
              value={props.window}
              onChange={(value) =>
                props.onWindowChange(value as SystemMetricsWindow)
              }
              data={WINDOW_OPTIONS}
            />
            <Badge color={props.fetching ? "blue" : "gray"} variant="light">
              {memory?.source ?? "waiting"}
            </Badge>
          </Group>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
            <MetricCard
              footer={
                cpu && (
                  <Stack gap={2}>
                    <Group gap="xs" wrap="wrap">
                      <Text c="dimmed" size="xs" tt="uppercase">
                        Load average
                      </Text>
                      <Text size="xs">
                        {cpu.loadAverage
                          .map((value) => value.toFixed(2))
                          .join(" · ")}
                      </Text>
                    </Group>
                    <Text c="dimmed" size="xs">
                      user {formatPercent(cpu.userPercent)} · system{" "}
                      {formatPercent(cpu.systemPercent)} · iowait{" "}
                      {formatPercent(cpu.ioWaitPercent)}
                      {cpu.stealPercent > 0
                        ? ` · steal ${formatPercent(cpu.stealPercent)}`
                        : ""}
                    </Text>
                  </Stack>
                )
              }
            >
              <MetricChart
                title="CPU"
                headline={formatPercent(cpu?.usagePercent)}
                axis={axis}
                domain={{ kind: "fixed", max: 100 }}
                formatValue={formatPercent}
                series={[
                  {
                    id: "cpu",
                    label: "Total",
                    tone: "cpu",
                    values: seriesFrom(samples, (sample) => sample.cpuPercent),
                  },
                ]}
              />
            </MetricCard>

            <MetricCard
              footer={
                <SimpleGrid cols={3} spacing="xs">
                  <ResourceMetric
                    label="Used"
                    value={formatBytes(memory?.usedBytes)}
                  />
                  <ResourceMetric
                    label="Available"
                    value={formatBytes(memory?.availableBytes)}
                  />
                  <ResourceMetric
                    label="Total"
                    value={formatBytes(memory?.totalBytes)}
                  />
                </SimpleGrid>
              }
            >
              <MetricChart
                title="Memory"
                headline={`${formatBytes(memory?.usedBytes)} / ${formatBytes(memory?.totalBytes)}`}
                axis={axis}
                domain={{
                  kind: "fixed",
                  max: memory?.totalBytes ?? latest?.memoryTotalBytes ?? 1,
                }}
                formatValue={formatBytes}
                series={[
                  {
                    id: "memory",
                    label: "Used",
                    tone: "memory",
                    values: seriesFrom(
                      samples,
                      (sample) => sample.memoryUsedBytes,
                    ),
                  },
                ]}
              />
            </MetricCard>
          </SimpleGrid>

          <MetricCard
            title="API event loop"
            meta={
              props.eventLoop && (
                <Badge
                  variant="light"
                  color={props.eventLoop.stalls.length ? "orange" : "gray"}
                >
                  {props.eventLoop.stalls.length
                    ? countLabel(props.eventLoop.stalls.length, "stall")
                    : "no stalls"}
                </Badge>
              )
            }
            footer={
              props.eventLoop && props.eventLoop.stalls.length > 0 ? (
                <Stack gap={2}>
                  {props.eventLoop.stalls.slice(0, 3).map((stall) => (
                    <Text key={stall.detectedAt} c="dimmed" size="xs">
                      {stallSummary(stall)}
                    </Text>
                  ))}
                </Stack>
              ) : (
                <Text c="dimmed" size="xs">
                  Longest single blockage of the manager event loop per sample
                  {props.eventLoop
                    ? `; stalls above ${formatMs(props.eventLoop.stallThresholdMs)} are reported with a verdict (own code vs host contention) and the blocking operations caught in the act.`
                    : "."}
                </Text>
              )
            }
          >
            <MetricChart
              title="Longest blockage"
              headline={formatMs(latest?.eventLoopMaxLagMs)}
              axis={axis}
              domain={{ kind: "auto", minimumMax: 100 }}
              formatValue={formatMs}
              height={DEVICE_CHART_HEIGHT}
              series={[
                {
                  id: "event-loop-lag",
                  label: "Max lag",
                  tone: "outbound",
                  values: seriesFrom(
                    samples,
                    (sample) => sample.eventLoopMaxLagMs,
                  ),
                },
              ]}
            />
          </MetricCard>

          {cpu && cpu.cores.length > 0 && (
            <MetricCard
              title="Logical processors"
              meta={
                <Badge variant="light" color="gray">
                  {countLabel(cpu.cores.length, "thread")}
                </Badge>
              }
            >
              <SimpleGrid cols={{ base: 4, sm: 8, md: 12 }} spacing={4}>
                {cpu.cores.map((core) => (
                  <Stack key={core.id} gap={2}>
                    <Progress
                      value={core.usagePercent}
                      color={loadColor(core.usagePercent / 100)}
                      size="sm"
                      radius="xs"
                    />
                    <Text c="dimmed" size="xs">
                      {core.id}
                    </Text>
                  </Stack>
                ))}
              </SimpleGrid>
            </MetricCard>
          )}

          <Divider />

          <Stack gap="xs">
            <SectionHeading
              title="Accelerators"
              badges={
                <Badge
                  variant="outline"
                  color={accelerators.length ? "green" : "gray"}
                >
                  {accelerators.length
                    ? `${accelerators.length} detected`
                    : "none detected"}
                </Badge>
              }
            />
            {accelerators.length === 0 ? (
              <Text c="dimmed" size="xs">
                No NVIDIA devices reported through NVML.
              </Text>
            ) : (
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                {accelerators.map((accelerator) => {
                  const gpuAt = (sample: SystemMetricsSample) =>
                    sample.gpus.find((entry) => entry.id === accelerator.id);
                  const usedBytes =
                    accelerator.totalMemoryBytes === null
                      ? null
                      : Math.round(
                          accelerator.totalMemoryBytes *
                            (accelerator.memoryUsedRatio ?? 0),
                        );
                  return (
                    <MetricCard
                      key={accelerator.id}
                      title={formatAcceleratorName(accelerator)}
                      meta={
                        <>
                          {acceleratorHealthBadges(accelerator).map((badge) => (
                            <Tooltip
                              key={badge.key}
                              label={badge.detail}
                              withArrow
                            >
                              <Badge color={badge.color} variant="light">
                                {badge.label}
                              </Badge>
                            </Tooltip>
                          ))}
                          {accelerator.temperatureC !== null && (
                            <Badge variant="light" color="gray">
                              {accelerator.temperatureC}C
                            </Badge>
                          )}
                          {accelerator.memoryTemperatureC !== undefined && (
                            <Badge variant="light" color="gray">
                              VRAM {accelerator.memoryTemperatureC}C
                            </Badge>
                          )}
                          {accelerator.numaNode !== null && (
                            <Badge variant="light" color="grape">
                              node {accelerator.numaNode}
                            </Badge>
                          )}
                          <Badge variant="light">
                            {accelerator.vendor ?? accelerator.source}
                          </Badge>
                        </>
                      }
                    >
                      <MetricChart
                        title="GPU load"
                        headline={formatPercent(accelerator.utilizationPercent)}
                        axis={axis}
                        domain={{ kind: "fixed", max: 100 }}
                        formatValue={formatPercent}
                        height={DEVICE_CHART_HEIGHT}
                        series={[
                          {
                            id: `gpu-${accelerator.id}-load`,
                            label: "Load",
                            tone: "gpuLoad",
                            values: seriesFrom(
                              samples,
                              (sample) => gpuAt(sample)?.utilizationPercent,
                            ),
                          },
                        ]}
                      />
                      <MetricChart
                        title="VRAM"
                        headline={
                          accelerator.totalMemoryBytes === null
                            ? "memory unknown"
                            : `${formatBytes(usedBytes)} / ${formatBytes(accelerator.totalMemoryBytes)}`
                        }
                        axis={axis}
                        domain={{
                          kind: "fixed",
                          max: accelerator.totalMemoryBytes ?? 1,
                        }}
                        formatValue={formatBytes}
                        height={DEVICE_CHART_HEIGHT}
                        series={[
                          {
                            id: `gpu-${accelerator.id}-vram`,
                            label: "Used",
                            tone: "gpuMemory",
                            values: seriesFrom(
                              samples,
                              (sample) => gpuAt(sample)?.memoryUsedBytes,
                            ),
                          },
                        ]}
                      />
                    </MetricCard>
                  );
                })}
              </SimpleGrid>
            )}
          </Stack>

          {disk && (
            <>
              <Divider />
              <Stack gap="xs">
                <SectionHeading
                  title="Disk activity"
                  badges={
                    <>
                      <Badge
                        variant="outline"
                        color={disk.devices.length ? "blue" : "gray"}
                      >
                        {disk.devices.length
                          ? countLabel(disk.devices.length, "disk")
                          : "none detected"}
                      </Badge>
                      {disk.ioPressure && (
                        <Badge
                          variant="light"
                          color={ioPressureColor(disk.ioPressure.avg10)}
                        >
                          I/O pressure {disk.ioPressure.avg10.toFixed(1)}%
                        </Badge>
                      )}
                    </>
                  }
                  meta={
                    <Group gap="md">
                      <Text c="dimmed" size="xs">
                        read {formatBytesPerSecond(disk.totalReadBytesPerSec)}
                      </Text>
                      <Text c="dimmed" size="xs">
                        write {formatBytesPerSecond(disk.totalWriteBytesPerSec)}
                      </Text>
                    </Group>
                  }
                />
                {disk.devices.length === 0 ? (
                  <Text c="dimmed" size="xs">
                    No physical disks reported by /proc/diskstats.
                  </Text>
                ) : (
                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                    {disk.devices.map((device) => {
                      const diskAt = (sample: SystemMetricsSample) =>
                        sample.disks.find(
                          (entry) => entry.name === device.name,
                        );
                      const throughput: MetricSeries[] = [
                        {
                          id: `${device.name}-read`,
                          label: "Read",
                          tone: "inbound",
                          values: seriesFrom(
                            samples,
                            (sample) => diskAt(sample)?.readBytesPerSec,
                          ),
                        },
                        {
                          id: `${device.name}-write`,
                          label: "Write",
                          tone: "outbound",
                          values: seriesFrom(
                            samples,
                            (sample) => diskAt(sample)?.writeBytesPerSec,
                          ),
                        },
                      ];
                      const counters =
                        device.readIops !== null ||
                        device.avgReadLatencyMs !== null;
                      return (
                        <MetricCard
                          key={device.name}
                          title={`${device.name}${device.model ? ` · ${device.model}` : ""}`}
                          meta={
                            <>
                              {device.sizeBytes !== null && (
                                <Badge variant="light" color="gray">
                                  {formatBytes(device.sizeBytes)}
                                </Badge>
                              )}
                              <Badge variant="light">
                                {diskTypeLabel(device.type)}
                              </Badge>
                            </>
                          }
                          {...(counters
                            ? {
                                footer: (
                                  <Text c="dimmed" size="xs">
                                    {device.readIops !== null
                                      ? `${Math.round(device.readIops + (device.writeIops ?? 0))} IOPS`
                                      : ""}
                                    {device.avgReadLatencyMs !== null
                                      ? ` · ${device.avgReadLatencyMs.toFixed(2)} ms read`
                                      : ""}
                                  </Text>
                                ),
                              }
                            : {})}
                        >
                          <MetricChart
                            title="Active time"
                            headline={formatPercent(device.utilPercent)}
                            axis={axis}
                            domain={{ kind: "fixed", max: 100 }}
                            formatValue={formatPercent}
                            height={DEVICE_CHART_HEIGHT}
                            series={[
                              {
                                id: `${device.name}-util`,
                                label: "Active",
                                tone: "cpu",
                                values: seriesFrom(
                                  samples,
                                  (sample) => diskAt(sample)?.utilPercent,
                                ),
                              },
                            ]}
                          />
                          <MetricChart
                            title="Transfer rate"
                            headline={`${formatBytesPerSecond(device.readBytesPerSec)} · ${formatBytesPerSecond(device.writeBytesPerSec)}`}
                            axis={axis}
                            domain={{ kind: "auto", minimumMax: 1024 * 1024 }}
                            formatValue={formatBytesPerSecond}
                            height={DEVICE_CHART_HEIGHT}
                            series={throughput}
                          />
                        </MetricCard>
                      );
                    })}
                  </SimpleGrid>
                )}
              </Stack>
            </>
          )}

          {storage && storage.filesystems.length > 0 && (
            <>
              <Divider />
              <Stack gap="xs">
                <SectionHeading
                  title="Storage space"
                  badges={
                    <Badge variant="outline" color="blue">
                      {countLabel(storage.filesystems.length, "filesystem")}
                    </Badge>
                  }
                />

                <Paper withBorder radius="sm" style={{ overflow: "hidden" }}>
                  <Table.ScrollContainer minWidth={680}>
                    <Table
                      horizontalSpacing="sm"
                      verticalSpacing="xs"
                      highlightOnHover
                    >
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Filesystem</Table.Th>
                          <Table.Th>Used</Table.Th>
                          <Table.Th ta="right">Free</Table.Th>
                          <Table.Th ta="right">Total</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {storage.filesystems.map((filesystem) => {
                          const percent = usedPercent(
                            filesystem.totalBytes,
                            filesystem.freeBytes,
                          );
                          const details = [
                            filesystem.source,
                            filesystem.cfgFile,
                            filesystem.freeInodes !== null
                              ? `${filesystem.freeInodes.toLocaleString("en")} free inodes`
                              : null,
                          ].filter((value): value is string => Boolean(value));
                          return (
                            <Table.Tr key={filesystem.mountPath}>
                              <Table.Td>
                                <Group gap="xs" wrap="nowrap">
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <Text fw={600} size="sm" lineClamp={1}>
                                      {filesystem.mountPath}
                                    </Text>
                                    <Text
                                      c="dimmed"
                                      size="xs"
                                      lineClamp={1}
                                      title={details.join(" · ")}
                                    >
                                      {details.join(" · ")}
                                    </Text>
                                  </div>
                                  <Badge
                                    variant="light"
                                    color={
                                      filesystem.kind === "beegfs"
                                        ? "blue"
                                        : "gray"
                                    }
                                  >
                                    {filesystem.kind === "beegfs"
                                      ? "BeeGFS"
                                      : filesystem.fsType}
                                  </Badge>
                                  {filesystem.error &&
                                    filesystem.totalBytes !== null && (
                                      <Badge variant="light" color="orange">
                                        stale
                                      </Badge>
                                    )}
                                </Group>
                              </Table.Td>
                              <Table.Td>
                                {percent !== null ? (
                                  <Group gap="xs" wrap="nowrap">
                                    <Progress
                                      value={percent}
                                      color={loadColor(percent / 100)}
                                      size="sm"
                                      radius="xs"
                                      style={{ flex: 1, minWidth: 100 }}
                                    />
                                    <Text size="xs" w={36} ta="right">
                                      {Math.round(percent)}%
                                    </Text>
                                  </Group>
                                ) : (
                                  <Text
                                    c={filesystem.error ? "orange" : "dimmed"}
                                    size="xs"
                                    title={filesystem.error ?? undefined}
                                  >
                                    {filesystem.error
                                      ? "Unavailable"
                                      : "Collecting…"}
                                  </Text>
                                )}
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text size="sm">
                                  {formatBytes(filesystem.freeBytes)}
                                </Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text size="sm" fw={600}>
                                  {formatBytes(filesystem.totalBytes)}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Paper>
              </Stack>
            </>
          )}

          {storage && rdma && (
            <>
              <Divider />
              <Stack gap="xs">
                <SectionHeading
                  title="Host RDMA traffic"
                  badges={
                    <Badge variant="outline" color="blue">
                      {rdma.device} · port {rdma.port}
                    </Badge>
                  }
                  meta={
                    <Group gap="md">
                      <Text c="dimmed" size="xs">
                        receive {formatBytesPerSecond(rdma.receiveBytesPerSec)}
                      </Text>
                      <Text c="dimmed" size="xs">
                        transmit{" "}
                        {formatBytesPerSecond(rdma.transmitBytesPerSec)}
                      </Text>
                    </Group>
                  }
                />
                <Text c="dimmed" size="xs">
                  Includes BeeGFS and any other RDMA traffic on this port, such
                  as NCCL.
                </Text>
                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                  <MetricCard title="All traffic on the RDMA port">
                    <MetricChart
                      title="Receive / transmit"
                      headline={`${formatBytesPerSecond(rdma.receiveBytesPerSec)} · ${formatBytesPerSecond(rdma.transmitBytesPerSec)}`}
                      axis={axis}
                      domain={{ kind: "auto", minimumMax: 1024 * 1024 }}
                      formatValue={formatBytesPerSecond}
                      height={DEVICE_CHART_HEIGHT}
                      series={[
                        {
                          id: `${rdma.device}-${rdma.port}-receive`,
                          label: "Receive",
                          tone: "inbound",
                          values: seriesFrom(samples, (sample) =>
                            sample.rdma?.device === rdma.device &&
                            sample.rdma.port === rdma.port
                              ? sample.rdma.receiveBytesPerSec
                              : null,
                          ),
                        },
                        {
                          id: `${rdma.device}-${rdma.port}-transmit`,
                          label: "Transmit",
                          tone: "outbound",
                          values: seriesFrom(samples, (sample) =>
                            sample.rdma?.device === rdma.device &&
                            sample.rdma.port === rdma.port
                              ? sample.rdma.transmitBytesPerSec
                              : null,
                          ),
                        },
                      ]}
                    />
                  </MetricCard>
                </SimpleGrid>
              </Stack>
            </>
          )}

          {network && (
            <>
              <Divider />
              <Stack gap="xs">
                <SectionHeading
                  title="Network activity"
                  badges={
                    <Badge
                      variant="outline"
                      color={network.interfaces.length ? "blue" : "gray"}
                    >
                      {network.interfaces.length
                        ? countLabel(network.interfaces.length, "interface")
                        : "none detected"}
                    </Badge>
                  }
                  meta={
                    <Group gap="md">
                      <Text c="dimmed" size="xs">
                        in {formatBytesPerSecond(network.totalRxBytesPerSec)}
                      </Text>
                      <Text c="dimmed" size="xs">
                        out {formatBytesPerSecond(network.totalTxBytesPerSec)}
                      </Text>
                    </Group>
                  }
                />
                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                  {network.interfaces.map((entry) => {
                    const netAt = (sample: SystemMetricsSample) =>
                      sample.network.find((item) => item.name === entry.name);
                    return (
                      <MetricCard
                        key={entry.name}
                        title={entry.name}
                        meta={
                          <>
                            {entry.speedMbps !== null && (
                              <Badge variant="light" color="gray">
                                {entry.speedMbps} Mb/s
                              </Badge>
                            )}
                            <Badge
                              variant="light"
                              color={entry.up ? "green" : "gray"}
                            >
                              {entry.up ? "up" : "down"}
                            </Badge>
                          </>
                        }
                      >
                        <MetricChart
                          title="Throughput"
                          headline={`${formatBytesPerSecond(entry.rxBytesPerSec)} · ${formatBytesPerSecond(entry.txBytesPerSec)}`}
                          axis={axis}
                          domain={{ kind: "auto", minimumMax: 128 * 1024 }}
                          formatValue={formatBytesPerSecond}
                          height={DEVICE_CHART_HEIGHT}
                          series={[
                            {
                              id: `${entry.name}-rx`,
                              label: "In",
                              tone: "inbound",
                              values: seriesFrom(
                                samples,
                                (sample) => netAt(sample)?.rxBytesPerSec,
                              ),
                            },
                            {
                              id: `${entry.name}-tx`,
                              label: "Out",
                              tone: "outbound",
                              values: seriesFrom(
                                samples,
                                (sample) => netAt(sample)?.txBytesPerSec,
                              ),
                            },
                          ]}
                        />
                      </MetricCard>
                    );
                  })}
                </SimpleGrid>
              </Stack>
            </>
          )}
        </Stack>
      </Paper>
    </MetricHoverProvider>
  );
}
