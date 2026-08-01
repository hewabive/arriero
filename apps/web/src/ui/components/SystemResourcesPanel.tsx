import {
  SystemMetricsWindowSchema,
  type SystemDiskDevice,
  type SystemMetricsSample,
  type SystemMetricsWindow,
  type SystemResources,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Code,
  Divider,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { useMemo, type ReactNode } from "react";

import { formatAcceleratorName } from "../utils/pools";
import { MetricCard } from "./MetricCard";
import {
  MetricChart,
  MetricHoverProvider,
  type MetricSeries,
} from "./MetricChart";

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

function formatRate(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return "-";
  }
  return `${formatBytes(value)}/s`;
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

function capacityPoolColor(pool: string | null) {
  if (pool === "emergency") return "red";
  if (pool === "low") return "orange";
  return "gray";
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

const WINDOW_OPTIONS = SystemMetricsWindowSchema.options.map((value) => ({
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
  const beegfs = props.resources?.beegfs ?? null;
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

          {cpu && cpu.cores.length > 0 && (
            <MetricCard
              title="Logical processors"
              meta={
                <Badge variant="light" color="gray">
                  {cpu.cores.length} threads
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
                          {accelerator.temperatureC !== null && (
                            <Badge variant="light" color="gray">
                              {accelerator.temperatureC}C
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
                          ? `${disk.devices.length} ${disk.devices.length === 1 ? "disk" : "disks"}`
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
                        read {formatRate(disk.totalReadBytesPerSec)}
                      </Text>
                      <Text c="dimmed" size="xs">
                        write {formatRate(disk.totalWriteBytesPerSec)}
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
                            headline={`${formatRate(device.readBytesPerSec)} · ${formatRate(device.writeBytesPerSec)}`}
                            axis={axis}
                            domain={{ kind: "auto", minimumMax: 1024 * 1024 }}
                            formatValue={formatRate}
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

          {beegfs?.status === "missing-tool" && (
            <Alert color="yellow" title="BeeGFS tooling is missing">
              <Stack gap="xs">
                <Text size="sm">
                  BeeGFS is mounted, but its target capacity cannot be read
                  because neither <Code>beegfs-df</Code> nor <Code>beegfs</Code>{" "}
                  is available to the manager.
                  {beegfs.clientVersion
                    ? ` Detected client version ${beegfs.clientVersion}.`
                    : ""}
                </Text>
                {beegfs.installCommand ? (
                  <Code
                    block
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {beegfs.installCommand}
                  </Code>
                ) : (
                  <Text size="sm">
                    Install the <Code>{beegfs.requiredPackage}</Code> package
                    from the configured BeeGFS repository.
                  </Text>
                )}
              </Stack>
            </Alert>
          )}

          {beegfs?.status === "error" && (
            <Alert color="orange" title="Could not read BeeGFS capacity">
              {beegfs.error}
            </Alert>
          )}

          {beegfs && beegfs.status !== "missing-tool" && (
            <>
              <Divider />
              <Stack gap="xs">
                <SectionHeading
                  title="BeeGFS space"
                  badges={
                    <>
                      <Badge variant="outline" color="blue">
                        {beegfs.filesystems.length}{" "}
                        {beegfs.filesystems.length === 1 ? "mount" : "mounts"}
                      </Badge>
                      {beegfs.tool && (
                        <Badge variant="light" color="gray">
                          {beegfs.tool}
                        </Badge>
                      )}
                    </>
                  }
                />

                {beegfs.filesystems.map((filesystem) => (
                  <Stack key={filesystem.mountPath} gap="xs">
                    <Group justify="space-between" gap="xs" wrap="wrap">
                      <Text fw={600} size="sm">
                        {filesystem.mountPath}
                      </Text>
                      <Badge variant="outline" color="gray">
                        {filesystem.targets.length}{" "}
                        {filesystem.targets.length === 1 ? "target" : "targets"}
                      </Badge>
                    </Group>

                    {filesystem.error && (
                      <Alert color="orange" title="BeeGFS query failed">
                        <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
                          {filesystem.error}
                        </Text>
                      </Alert>
                    )}

                    {!filesystem.error && filesystem.targets.length === 0 && (
                      <Text c="dimmed" size="xs">
                        No metadata or storage targets were reported.
                      </Text>
                    )}

                    {filesystem.targets.length > 0 && (
                      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                        {filesystem.targets.map((target) => {
                          const percent = usedPercent(
                            target.totalBytes,
                            target.freeBytes,
                          );
                          const used = usedValue(
                            target.totalBytes,
                            target.freeBytes,
                          );
                          return (
                            <MetricCard
                              key={`${target.kind}-${target.id}`}
                              title={
                                target.alias ??
                                `${target.kind === "metadata" ? "Metadata" : "Storage"} target ${target.id}`
                              }
                              meta={
                                <>
                                  <Badge variant="light">{target.kind}</Badge>
                                  {target.capacityPool && (
                                    <Badge
                                      variant="light"
                                      color={capacityPoolColor(
                                        target.capacityPool,
                                      )}
                                    >
                                      {target.capacityPool}
                                    </Badge>
                                  )}
                                </>
                              }
                              footer={
                                <Text c="dimmed" size="xs">
                                  ID {target.id}
                                  {target.node ? ` · node ${target.node}` : ""}
                                  {target.storagePool
                                    ? ` · pool ${target.storagePool}`
                                    : ""}
                                  {target.freeInodes !== null
                                    ? ` · ${target.freeInodes.toLocaleString("en")} free inodes`
                                    : ""}
                                </Text>
                              }
                            >
                              {percent !== null && (
                                <Progress
                                  value={percent}
                                  color={loadColor(percent / 100)}
                                  size="sm"
                                  radius="xs"
                                />
                              )}
                              <SimpleGrid cols={3} spacing="xs">
                                <ResourceMetric
                                  label="Used"
                                  value={formatBytes(used)}
                                />
                                <ResourceMetric
                                  label="Free"
                                  value={formatBytes(target.freeBytes)}
                                />
                                <ResourceMetric
                                  label="Total"
                                  value={formatBytes(target.totalBytes)}
                                />
                              </SimpleGrid>
                            </MetricCard>
                          );
                        })}
                      </SimpleGrid>
                    )}
                  </Stack>
                ))}
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
                        ? `${network.interfaces.length} ${network.interfaces.length === 1 ? "interface" : "interfaces"}`
                        : "none detected"}
                    </Badge>
                  }
                  meta={
                    <Group gap="md">
                      <Text c="dimmed" size="xs">
                        in {formatRate(network.totalRxBytesPerSec)}
                      </Text>
                      <Text c="dimmed" size="xs">
                        out {formatRate(network.totalTxBytesPerSec)}
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
                          headline={`${formatRate(entry.rxBytesPerSec)} · ${formatRate(entry.txBytesPerSec)}`}
                          axis={axis}
                          domain={{ kind: "auto", minimumMax: 128 * 1024 }}
                          formatValue={formatRate}
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
