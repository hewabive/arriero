import type {
  InstanceMemoryDraw,
  InstanceMemoryLayout,
  InstanceMemoryPlacement,
} from "@llama-manager/core";
import { Badge, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";

import { formatBytes } from "./instance-details-helpers";

function formatMemoryBytes(value: number) {
  return value > 0 ? (formatBytes(value) ?? "-") : "-";
}

function formatMemoryDelta(value: number) {
  if (value === 0) return "0 B";
  return `${value > 0 ? "+" : "-"}${formatBytes(Math.abs(value)) ?? "-"}`;
}

function memoryKindLabel(kind: InstanceMemoryPlacement["kind"]) {
  if (kind === "device") return "VRAM";
  if (kind === "host") return "RAM";
  return "Other";
}

function memoryKindColor(kind: InstanceMemoryPlacement["kind"]) {
  if (kind === "device") return "blue";
  if (kind === "host") return "green";
  return "gray";
}

function MemoryMetric(props: { label: string; value: number }) {
  return (
    <Text size="xs">
      {props.label}:{" "}
      <Text span c="dimmed">
        {formatMemoryBytes(props.value)}
      </Text>
    </Text>
  );
}

function memoryLayoutSourceText(layout: InstanceMemoryLayout | undefined) {
  if (!layout) {
    return "Waiting for memory telemetry.";
  }
  if (layout.sourceDetail) {
    return layout.sourceDetail;
  }
  if (layout.source === "process-telemetry") {
    return "Process-level runtime memory from nvidia-smi and /proc.";
  }
  if (layout.source === "log-projection") {
    return "Host memory projection parsed from llama.cpp logs.";
  }
  if (layout.source === "log-buffers") {
    return "Exact llama.cpp buffer allocation lines parsed from logs.";
  }
  return "No memory telemetry is available yet.";
}

function memoryLayoutBadge(layout: InstanceMemoryLayout | undefined) {
  if (!layout) return "no data";
  if (layout.totalBytes > 0) {
    return formatMemoryBytes(layout.totalBytes);
  }
  if (layout.projectedHostBytes !== null && layout.projectedHostBytes > 0) {
    return `estimate ${formatMemoryBytes(layout.projectedHostBytes)}`;
  }
  return "no data";
}

export function MemoryLayoutPanel(props: {
  layout: InstanceMemoryLayout | undefined;
  declared?: InstanceMemoryDraw[] | undefined;
}) {
  const layout = props.layout;
  const entries = layout?.entries ?? [];
  const hasRuntimeEntries = layout && layout.totalBytes > 0 ? layout : null;
  const processTelemetry = layout?.source === "process-telemetry";
  const projectedHostBytes = layout?.projectedHostBytes ?? null;
  const projectedHostTotalBytes = layout?.projectedHostTotalBytes ?? null;
  const hasProjection = projectedHostBytes !== null && projectedHostBytes > 0;
  const declaredBytes = (props.declared ?? []).reduce(
    (sum, draw) => sum + draw.bytes,
    0,
  );
  const measuredDelta =
    layout && layout.source === "process-telemetry" && declaredBytes > 0
      ? layout.totalBytes - declaredBytes
      : null;

  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" mb="xs">
        <Stack gap={2}>
          <Text fw={600} size="sm">
            Memory layout
          </Text>
          <Text c="dimmed" size="xs">
            {memoryLayoutSourceText(layout)}
          </Text>
        </Stack>
        <Badge {...(processTelemetry ? { color: "cyan" } : {})} variant="light">
          {memoryLayoutBadge(layout)}
        </Badge>
      </Group>

      {declaredBytes > 0 && (
        <Group gap="xs" mb="xs">
          <Badge variant="outline">
            Declared reservation {formatMemoryBytes(declaredBytes)}
          </Badge>
          {measuredDelta !== null && (
            <Badge
              color={measuredDelta > 0 ? "orange" : "gray"}
              variant="light"
            >
              Measured {formatMemoryDelta(measuredDelta)} vs declared
            </Badge>
          )}
        </Group>
      )}

      {hasRuntimeEntries ? (
        <Stack gap="xs">
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
            <MemoryMetric
              label="VRAM total"
              value={hasRuntimeEntries.deviceBytes}
            />
            <MemoryMetric
              label={processTelemetry ? "Committed RAM" : "RAM total"}
              value={hasRuntimeEntries.hostBytes}
            />
            <MemoryMetric
              label={processTelemetry ? "Reclaimable (mmap)" : "Other"}
              value={hasRuntimeEntries.otherBytes}
            />
          </SimpleGrid>
          {processTelemetry && layout.processIds.length > 0 && (
            <Text c="dimmed" size="xs">
              PIDs: {layout.processIds.join(", ")}
            </Text>
          )}

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
            {entries.map((entry) => (
              <Paper key={entry.label} withBorder p="xs" radius="sm">
                <Stack gap={6}>
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text fw={600} size="sm" lineClamp={1}>
                      {entry.label}
                    </Text>
                    <Group gap={4} wrap="nowrap">
                      <Badge
                        color={memoryKindColor(entry.kind)}
                        variant="light"
                        size="xs"
                      >
                        {memoryKindLabel(entry.kind)}
                      </Badge>
                      <Badge variant="outline" size="xs">
                        {formatMemoryBytes(entry.totalBytes)}
                      </Badge>
                    </Group>
                  </Group>
                  {processTelemetry ? null : (
                    <SimpleGrid cols={{ base: 2, sm: 3 }} spacing={4}>
                      <MemoryMetric label="Model" value={entry.modelBytes} />
                      <MemoryMetric
                        label="KV/context"
                        value={entry.contextBytes}
                      />
                      <MemoryMetric
                        label="Compute"
                        value={entry.computeBytes}
                      />
                      <MemoryMetric label="Output" value={entry.outputBytes} />
                      <MemoryMetric
                        label="Adapters"
                        value={entry.adapterBytes}
                      />
                      <MemoryMetric label="Other" value={entry.otherBytes} />
                    </SimpleGrid>
                  )}
                </Stack>
              </Paper>
            ))}
          </SimpleGrid>
        </Stack>
      ) : hasProjection ? (
        <Stack gap="xs">
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
            <MemoryMetric
              label="Projected RAM"
              value={projectedHostBytes ?? 0}
            />
            <MemoryMetric
              label="Host total"
              value={projectedHostTotalBytes ?? 0}
            />
            <Text size="xs">
              Exact buffers:{" "}
              <Text span c="dimmed">
                -
              </Text>
            </Text>
          </SimpleGrid>
          <Text c="dimmed" size="xs">
            llama.cpp did not emit per-buffer allocation lines for this run; the
            host memory projection is shown instead.
          </Text>
        </Stack>
      ) : (
        <Text c="dimmed" size="xs">
          No memory buffer lines parsed yet. Start or restart the instance; the
          data appears while llama.cpp initializes model and context buffers.
        </Text>
      )}
    </Paper>
  );
}
