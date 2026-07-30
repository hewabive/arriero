import type { SystemDiskDevice, SystemResources } from "@arriero/core";
import {
  Badge,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";

import { formatAcceleratorName } from "../utils/pools";

const bytesFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
});

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

function formatRatio(value: number | undefined) {
  if (value === undefined) {
    return "-";
  }
  return `${Math.round(value * 100)}%`;
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

function memoryColor(usedRatio: number | undefined) {
  if (usedRatio === undefined) return "gray";
  if (usedRatio >= 0.9) return "red";
  if (usedRatio >= 0.75) return "orange";
  return "green";
}

function acceleratorMemoryLabel(
  accelerator: SystemResources["accelerators"][number],
) {
  if (accelerator.totalMemoryBytes === null) {
    return "memory unknown";
  }
  const usedRatio = accelerator.memoryUsedRatio ?? 0;
  const usedBytes = Math.round(accelerator.totalMemoryBytes * usedRatio);
  return `${formatBytes(usedBytes)} / ${formatBytes(accelerator.totalMemoryBytes)}`;
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

export function SystemResourcesPanel(props: {
  resources: SystemResources | undefined;
  fetching?: boolean;
}) {
  const memory = props.resources?.memory;
  const memoryPercent = memory ? Math.round(memory.usedRatio * 100) : 0;
  const accelerators = props.resources?.accelerators ?? [];
  const disk = props.resources?.disk ?? null;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div className="section-heading">
            <Text fw={700} size="lg">
              System resources
            </Text>
            <Text c="dimmed" size="sm">
              RAM, accelerator, and disk activity
            </Text>
          </div>
          <Badge color={props.fetching ? "blue" : "gray"} variant="light">
            {memory?.source ?? "waiting"}
          </Badge>
        </Group>

        <Stack gap={6}>
          <Group justify="space-between">
            <Text fw={700}>Memory</Text>
            <Text c="dimmed" size="sm">
              {formatRatio(memory?.usedRatio)} used
            </Text>
          </Group>
          <Progress
            value={memoryPercent}
            color={memoryColor(memory?.usedRatio)}
            size="lg"
            radius="xs"
          />
        </Stack>

        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <ResourceMetric label="Used" value={formatBytes(memory?.usedBytes)} />
          <ResourceMetric
            label="Available"
            value={formatBytes(memory?.availableBytes)}
          />
          <ResourceMetric
            label="Total"
            value={formatBytes(memory?.totalBytes)}
          />
        </SimpleGrid>

        <Stack gap="xs">
          <Group gap="xs">
            <Text c="dimmed" size="sm">
              Accelerators
            </Text>
            <Badge
              variant="outline"
              color={accelerators.length ? "green" : "gray"}
            >
              {accelerators.length
                ? `${accelerators.length} detected`
                : "none detected"}
            </Badge>
          </Group>
          {accelerators.length === 0 ? (
            <Text c="dimmed" size="xs">
              No NVIDIA devices reported by NVML.
            </Text>
          ) : (
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
              {accelerators.map((accelerator) => (
                <Paper key={accelerator.id} withBorder p="xs" radius="sm">
                  <Stack gap={6}>
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Text fw={600} size="sm" lineClamp={1}>
                        {formatAcceleratorName(accelerator)}
                      </Text>
                      <Group gap={4} wrap="nowrap">
                        {accelerator.numaNode !== null && (
                          <Badge variant="light" color="grape">
                            node {accelerator.numaNode}
                          </Badge>
                        )}
                        <Badge variant="light">
                          {accelerator.vendor ?? accelerator.source}
                        </Badge>
                      </Group>
                    </Group>
                    <Stack gap={2}>
                      <Group justify="space-between" gap="xs">
                        <Text c="dimmed" size="xs" tt="uppercase">
                          VRAM
                        </Text>
                        <Text c="dimmed" size="xs">
                          {acceleratorMemoryLabel(accelerator)}
                        </Text>
                      </Group>
                      <Progress
                        value={Math.round(
                          (accelerator.memoryUsedRatio ?? 0) * 100,
                        )}
                        color={memoryColor(
                          accelerator.memoryUsedRatio ?? undefined,
                        )}
                        size="sm"
                        radius="xs"
                      />
                    </Stack>
                    {accelerator.utilizationPercent !== null && (
                      <Stack gap={2}>
                        <Group justify="space-between" gap="xs">
                          <Text c="dimmed" size="xs" tt="uppercase">
                            GPU load
                          </Text>
                          <Text c="dimmed" size="xs">
                            {accelerator.utilizationPercent}%
                          </Text>
                        </Group>
                        <Progress
                          value={accelerator.utilizationPercent}
                          color={memoryColor(
                            accelerator.utilizationPercent / 100,
                          )}
                          size="sm"
                          radius="xs"
                        />
                      </Stack>
                    )}
                    {accelerator.temperatureC !== null && (
                      <Text c="dimmed" size="xs">
                        {accelerator.temperatureC}C
                      </Text>
                    )}
                  </Stack>
                </Paper>
              ))}
            </SimpleGrid>
          )}
        </Stack>

        {disk && (
          <Stack gap="xs">
            <Group gap="xs" justify="space-between">
              <Group gap="xs">
                <Text c="dimmed" size="sm">
                  Disk activity
                </Text>
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
              </Group>
              <Group gap="md">
                <Text c="dimmed" size="xs">
                  read {formatRate(disk.totalReadBytesPerSec)}
                </Text>
                <Text c="dimmed" size="xs">
                  write {formatRate(disk.totalWriteBytesPerSec)}
                </Text>
              </Group>
            </Group>
            {disk.devices.length === 0 ? (
              <Text c="dimmed" size="xs">
                No physical disks reported by /proc/diskstats.
              </Text>
            ) : (
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                {disk.devices.map((device) => (
                  <Paper key={device.name} withBorder p="xs" radius="sm">
                    <Stack gap={6}>
                      <Group justify="space-between" gap="xs" wrap="nowrap">
                        <Text fw={600} size="sm" lineClamp={1}>
                          {device.name}
                          {device.model ? ` · ${device.model}` : ""}
                        </Text>
                        <Group gap={4} wrap="nowrap">
                          {device.sizeBytes !== null && (
                            <Badge variant="light" color="gray">
                              {formatBytes(device.sizeBytes)}
                            </Badge>
                          )}
                          <Badge variant="light">
                            {diskTypeLabel(device.type)}
                          </Badge>
                        </Group>
                      </Group>
                      <Stack gap={2}>
                        <Group justify="space-between" gap="xs">
                          <Text c="dimmed" size="xs" tt="uppercase">
                            Active time
                          </Text>
                          <Text c="dimmed" size="xs">
                            {device.utilPercent === null
                              ? "-"
                              : `${Math.round(device.utilPercent)}%`}
                          </Text>
                        </Group>
                        <Progress
                          value={device.utilPercent ?? 0}
                          color={memoryColor((device.utilPercent ?? 0) / 100)}
                          size="sm"
                          radius="xs"
                        />
                      </Stack>
                      <SimpleGrid cols={2} spacing="xs" verticalSpacing={2}>
                        <Text size="xs">
                          <Text span c="dimmed">
                            R{" "}
                          </Text>
                          {formatRate(device.readBytesPerSec)}
                        </Text>
                        <Text size="xs">
                          <Text span c="dimmed">
                            W{" "}
                          </Text>
                          {formatRate(device.writeBytesPerSec)}
                        </Text>
                      </SimpleGrid>
                      {(device.readIops !== null ||
                        device.avgReadLatencyMs !== null) && (
                        <Text c="dimmed" size="xs">
                          {device.readIops !== null
                            ? `${Math.round(device.readIops + (device.writeIops ?? 0))} IOPS`
                            : ""}
                          {device.avgReadLatencyMs !== null
                            ? ` · ${device.avgReadLatencyMs.toFixed(2)} ms read`
                            : ""}
                        </Text>
                      )}
                    </Stack>
                  </Paper>
                ))}
              </SimpleGrid>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
