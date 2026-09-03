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
  type SystemCpuActivity,
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

import { formatBytes, formatBytesPerSecond } from "../utils/models";
import { formatAcceleratorName } from "../utils/pools";
import { formatLocalClock } from "../utils/time";
import { formatDurationMs } from "../views/benchmark-format";
import { MetricCard } from "./MetricCard";
import {
  MetricChart,
  MetricHoverProvider,
  type MetricDomain,
  type MetricSeries,
} from "./MetricChart";
import { countLabel } from "../utils/plural";

const DEVICE_CHART_HEIGHT = 92;

const PERCENT_DOMAIN: MetricDomain = { kind: "fixed", max: 100 };
const LAG_DOMAIN: MetricDomain = { kind: "auto", minimumMax: 100 };
const THROUGHPUT_DOMAIN: MetricDomain = {
  kind: "auto",
  minimumMax: 1024 * 1024,
};
const NETWORK_THROUGHPUT_DOMAIN: MetricDomain = {
  kind: "auto",
  minimumMax: 128 * 1024,
};
const CPU_DELIVERY_MIN_DEMAND_PERCENT = 10;
const CPU_EFFECTIVE_CAPACITY_MIN_DEMAND_PERCENT = 80;

function formatOptionalBytes(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "-";
  }
  return formatBytes(value);
}

function formatPercent(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "-";
  }
  return `${Math.round(value)}%`;
}

function cpuDeliveryEstimate(cpu: SystemCpuActivity) {
  const grantedPercent = Math.max(
    0,
    Math.min(100, cpu.userPercent + cpu.systemPercent),
  );
  const demandPercent = grantedPercent + cpu.stealPercent;
  if (demandPercent < CPU_DELIVERY_MIN_DEMAND_PERCENT) {
    return null;
  }
  const deliveryPercent = (grantedPercent / demandPercent) * 100;
  return {
    deliveryPercent,
    effectiveCpuCount:
      demandPercent >= CPU_EFFECTIVE_CAPACITY_MIN_DEMAND_PERCENT
        ? (cpu.cores.length * deliveryPercent) / 100
        : null,
  };
}

function cpuDeliveryColor(percent: number) {
  if (percent < 50) return "red";
  if (percent < 80) return "orange";
  if (percent < 95) return "yellow";
  return "green";
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

type SeriesValues = (number | null)[];

type ChartSeriesIndex = {
  cpu: MetricSeries[];
  memory: MetricSeries[];
  eventLoopLag: MetricSeries[];
  gpuLoad: (id: string) => MetricSeries[];
  gpuVram: (id: string) => MetricSeries[];
  diskUtil: (name: string) => MetricSeries[];
  diskThroughput: (name: string) => MetricSeries[];
  networkThroughput: (name: string) => MetricSeries[];
  rdmaTraffic: (device: string, port: number) => MetricSeries[];
};

function mapEntry<T>(map: Map<string, T>, key: string, create: () => T): T {
  let entry = map.get(key);
  if (!entry) {
    entry = create();
    map.set(key, entry);
  }
  return entry;
}

function buildChartSeriesIndex(
  samples: SystemMetricsSample[],
): ChartSeriesIndex {
  const filled = (): SeriesValues =>
    new Array<number | null>(samples.length).fill(null);
  const cpuValues = filled();
  const cpuGrantedValues = filled();
  const cpuStealValues = filled();
  const memoryValues = filled();
  const lagValues = filled();
  const gpuValues = new Map<
    string,
    { load: SeriesValues; vram: SeriesValues }
  >();
  const diskValues = new Map<
    string,
    { util: SeriesValues; read: SeriesValues; write: SeriesValues }
  >();
  const networkValues = new Map<
    string,
    { rx: SeriesValues; tx: SeriesValues }
  >();
  const rdmaValues = new Map<
    string,
    { receive: SeriesValues; transmit: SeriesValues }
  >();

  samples.forEach((sample, index) => {
    cpuValues[index] = sample.cpuPercent;
    if (sample.cpuPercent !== null && sample.cpuStealPercent !== null) {
      cpuGrantedValues[index] = Math.max(
        0,
        sample.cpuPercent - sample.cpuStealPercent,
      );
      cpuStealValues[index] = sample.cpuStealPercent;
    }
    memoryValues[index] = sample.memoryUsedBytes;
    lagValues[index] = sample.eventLoopMaxLagMs;
    for (const gpu of sample.gpus) {
      const entry = mapEntry(gpuValues, gpu.id, () => ({
        load: filled(),
        vram: filled(),
      }));
      entry.load[index] = gpu.utilizationPercent;
      entry.vram[index] = gpu.memoryUsedBytes;
    }
    for (const device of sample.disks) {
      const entry = mapEntry(diskValues, device.name, () => ({
        util: filled(),
        read: filled(),
        write: filled(),
      }));
      entry.util[index] = device.utilPercent;
      entry.read[index] = device.readBytesPerSec;
      entry.write[index] = device.writeBytesPerSec;
    }
    for (const item of sample.network) {
      const entry = mapEntry(networkValues, item.name, () => ({
        rx: filled(),
        tx: filled(),
      }));
      entry.rx[index] = item.rxBytesPerSec;
      entry.tx[index] = item.txBytesPerSec;
    }
    if (sample.rdma) {
      const entry = mapEntry(
        rdmaValues,
        `${sample.rdma.device}:${sample.rdma.port}`,
        () => ({ receive: filled(), transmit: filled() }),
      );
      entry.receive[index] = sample.rdma.receiveBytesPerSec;
      entry.transmit[index] = sample.rdma.transmitBytesPerSec;
    }
  });

  const seriesCache = new Map<string, MetricSeries[]>();
  const cached = (key: string, build: () => MetricSeries[]) =>
    mapEntry(seriesCache, key, build);

  return {
    cpu: [
      { id: "cpu-demand", label: "Demand", tone: "cpu", values: cpuValues },
      {
        id: "cpu-granted",
        label: "Guest work",
        tone: "memory",
        values: cpuGrantedValues,
      },
      {
        id: "cpu-steal",
        label: "Hypervisor steal",
        tone: "outbound",
        values: cpuStealValues,
      },
    ],
    memory: [
      { id: "memory", label: "Used", tone: "memory", values: memoryValues },
    ],
    eventLoopLag: [
      {
        id: "event-loop-lag",
        label: "Max lag",
        tone: "outbound",
        values: lagValues,
      },
    ],
    gpuLoad: (id) =>
      cached(`gpu-load:${id}`, () => [
        {
          id: `gpu-${id}-load`,
          label: "Load",
          tone: "gpuLoad",
          values: gpuValues.get(id)?.load ?? filled(),
        },
      ]),
    gpuVram: (id) =>
      cached(`gpu-vram:${id}`, () => [
        {
          id: `gpu-${id}-vram`,
          label: "Used",
          tone: "gpuMemory",
          values: gpuValues.get(id)?.vram ?? filled(),
        },
      ]),
    diskUtil: (name) =>
      cached(`disk-util:${name}`, () => [
        {
          id: `${name}-util`,
          label: "Active",
          tone: "cpu",
          values: diskValues.get(name)?.util ?? filled(),
        },
      ]),
    diskThroughput: (name) =>
      cached(`disk-io:${name}`, () => [
        {
          id: `${name}-read`,
          label: "Read",
          tone: "inbound",
          values: diskValues.get(name)?.read ?? filled(),
        },
        {
          id: `${name}-write`,
          label: "Write",
          tone: "outbound",
          values: diskValues.get(name)?.write ?? filled(),
        },
      ]),
    networkThroughput: (name) =>
      cached(`net:${name}`, () => [
        {
          id: `${name}-rx`,
          label: "In",
          tone: "inbound",
          values: networkValues.get(name)?.rx ?? filled(),
        },
        {
          id: `${name}-tx`,
          label: "Out",
          tone: "outbound",
          values: networkValues.get(name)?.tx ?? filled(),
        },
      ]),
    rdmaTraffic: (device, port) =>
      cached(`rdma:${device}:${port}`, () => [
        {
          id: `${device}-${port}-receive`,
          label: "Receive",
          tone: "inbound",
          values: rdmaValues.get(`${device}:${port}`)?.receive ?? filled(),
        },
        {
          id: `${device}-${port}-transmit`,
          label: "Transmit",
          tone: "outbound",
          values: rdmaValues.get(`${device}:${port}`)?.transmit ?? filled(),
        },
      ]),
  };
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
  const virtualization = props.resources?.virtualization ?? null;
  const cpuDelivery = cpu ? cpuDeliveryEstimate(cpu) : null;
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
  const chartSeries = useMemo(() => buildChartSeriesIndex(samples), [samples]);

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
                    {virtualization && (
                      <Group gap="xs" wrap="wrap">
                        <Badge variant="light" color="gray" size="sm">
                          {virtualization.type.toUpperCase()} guest
                        </Badge>
                        {cpuDelivery && (
                          <Tooltip
                            withArrow
                            multiline
                            w={320}
                            label="Derived from Linux steal time for the current sample. It measures CPU time delivered while the guest requested it; it is not the provider's contractual CPU quota. Effective vCPU capacity is shown only near full demand."
                          >
                            <Badge
                              variant="light"
                              color={cpuDeliveryColor(
                                cpuDelivery.deliveryPercent,
                              )}
                              size="sm"
                            >
                              Hypervisor delivery{" "}
                              {formatPercent(cpuDelivery.deliveryPercent)}
                              {cpuDelivery.effectiveCpuCount === null
                                ? ""
                                : ` · ~${cpuDelivery.effectiveCpuCount.toFixed(1)} / ${cpu.cores.length} vCPU`}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                    )}
                  </Stack>
                )
              }
            >
              <MetricChart
                title="CPU"
                headline={formatPercent(cpu?.usagePercent)}
                axis={axis}
                domain={PERCENT_DOMAIN}
                formatValue={formatPercent}
                series={chartSeries.cpu}
              />
            </MetricCard>

            <MetricCard
              footer={
                <SimpleGrid cols={3} spacing="xs">
                  <ResourceMetric
                    label="Used"
                    value={formatOptionalBytes(memory?.usedBytes)}
                  />
                  <ResourceMetric
                    label="Available"
                    value={formatOptionalBytes(memory?.availableBytes)}
                  />
                  <ResourceMetric
                    label="Total"
                    value={formatOptionalBytes(memory?.totalBytes)}
                  />
                </SimpleGrid>
              }
            >
              <MetricChart
                title="Memory"
                headline={`${formatOptionalBytes(memory?.usedBytes)} / ${formatOptionalBytes(memory?.totalBytes)}`}
                axis={axis}
                domain={{
                  kind: "fixed",
                  max: memory?.totalBytes ?? latest?.memoryTotalBytes ?? 1,
                }}
                formatValue={formatOptionalBytes}
                series={chartSeries.memory}
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
              domain={LAG_DOMAIN}
              formatValue={formatMs}
              height={DEVICE_CHART_HEIGHT}
              series={chartSeries.eventLoopLag}
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
              <SimpleGrid minColWidth="4rem" spacing={4}>
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
                        domain={PERCENT_DOMAIN}
                        formatValue={formatPercent}
                        height={DEVICE_CHART_HEIGHT}
                        series={chartSeries.gpuLoad(accelerator.id)}
                      />
                      <MetricChart
                        title="VRAM"
                        headline={
                          accelerator.totalMemoryBytes === null
                            ? "memory unknown"
                            : `${formatOptionalBytes(usedBytes)} / ${formatOptionalBytes(accelerator.totalMemoryBytes)}`
                        }
                        axis={axis}
                        domain={{
                          kind: "fixed",
                          max: accelerator.totalMemoryBytes ?? 1,
                        }}
                        formatValue={formatOptionalBytes}
                        height={DEVICE_CHART_HEIGHT}
                        series={chartSeries.gpuVram(accelerator.id)}
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
                                  {formatOptionalBytes(device.sizeBytes)}
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
                            domain={PERCENT_DOMAIN}
                            formatValue={formatPercent}
                            height={DEVICE_CHART_HEIGHT}
                            series={chartSeries.diskUtil(device.name)}
                          />
                          <MetricChart
                            title="Transfer rate"
                            headline={`${formatBytesPerSecond(device.readBytesPerSec)} · ${formatBytesPerSecond(device.writeBytesPerSec)}`}
                            axis={axis}
                            domain={THROUGHPUT_DOMAIN}
                            formatValue={formatBytesPerSecond}
                            height={DEVICE_CHART_HEIGHT}
                            series={chartSeries.diskThroughput(device.name)}
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
                                  {formatOptionalBytes(filesystem.freeBytes)}
                                </Text>
                              </Table.Td>
                              <Table.Td ta="right">
                                <Text size="sm" fw={600}>
                                  {formatOptionalBytes(filesystem.totalBytes)}
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
                      domain={THROUGHPUT_DOMAIN}
                      formatValue={formatBytesPerSecond}
                      height={DEVICE_CHART_HEIGHT}
                      series={chartSeries.rdmaTraffic(rdma.device, rdma.port)}
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
                          domain={NETWORK_THROUGHPUT_DOMAIN}
                          formatValue={formatBytesPerSecond}
                          height={DEVICE_CHART_HEIGHT}
                          series={chartSeries.networkThroughput(entry.name)}
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
