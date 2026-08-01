import type { NumaNode, SystemResources } from "@arriero/core";
import {
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { Cpu, Database, MemoryStick } from "lucide-react";

import { formatBytes } from "../utils/models";
import { formatAcceleratorName } from "../utils/pools";
import { countLabel } from "../utils/plural";

function capabilityBadge(label: string, available: boolean) {
  return (
    <Badge variant="light" color={available ? "green" : "gray"}>
      {label} {available ? "ready" : "n/a"}
    </Badge>
  );
}

function freeColor(freeRatio: number) {
  if (freeRatio < 0.05) {
    return "red";
  }
  if (freeRatio < 0.15) {
    return "yellow";
  }
  return "gray";
}

function cacheColor(cacheRatio: number) {
  if (cacheRatio > 0.6) {
    return "orange";
  }
  if (cacheRatio > 0.3) {
    return "yellow";
  }
  return "gray";
}

function NodeMemoryBadges(props: { node: NumaNode }) {
  const { node } = props;
  if (node.memoryBytes <= 0) {
    return null;
  }
  const freeRatio = node.memFreeBytes / node.memoryBytes;
  const cacheRatio = node.filePagesBytes / node.memoryBytes;
  return (
    <>
      <Tooltip label={`${Math.round(freeRatio * 100)}% free`}>
        <Badge variant="light" color={freeColor(freeRatio)}>
          {formatBytes(node.memFreeBytes)} free
        </Badge>
      </Tooltip>
      <Tooltip
        label={`Page cache on this node — ${Math.round(
          cacheRatio * 100,
        )}% of node memory. A node heavily filled by cache (e.g. after a bulk file copy) starves even interleave placement.`}
      >
        <Badge
          variant="light"
          color={cacheColor(cacheRatio)}
          leftSection={<Database size={12} />}
        >
          {formatBytes(node.filePagesBytes)} cache
        </Badge>
      </Tooltip>
    </>
  );
}

export function NumaTopologyPanel(props: { resources: SystemResources }) {
  const { numa, accelerators } = props.resources;
  const numaNodes = numa.nodes;
  const unmapped = accelerators.filter(
    (accelerator) => accelerator.numaNode === null,
  );

  return (
    <Paper withBorder p="md" radius="sm">
      <Group justify="space-between" align="center" wrap="wrap">
        <Group gap="xs" wrap="wrap">
          <Title order={4}>NUMA topology</Title>
          <Badge variant="light">{countLabel(numaNodes.length, "node")}</Badge>
        </Group>
        <Group gap="xs" wrap="wrap">
          {capabilityBadge("bind", numa.bind)}
          {capabilityBadge("interleave", numa.interleave)}
        </Group>
      </Group>
      <Text c="dimmed" size="sm" mt={6}>
        Per-socket cores, memory, free RAM, page cache and the GPUs attached to
        each node. Bind an instance to the node hosting its GPU to keep
        host-side traffic local; watch for a single node dominated by page
        cache, which skews interleave placement.
      </Text>

      <Stack gap="sm" mt="md">
        {numaNodes.map((node) => {
          const gpus = accelerators.filter(
            (accelerator) => accelerator.numaNode === node.id,
          );
          return (
            <Paper key={node.id} withBorder p="md" radius="sm">
              <Group justify="space-between" align="flex-start" wrap="wrap">
                <Group gap="sm" align="flex-start" wrap="nowrap">
                  <ThemeIcon color="blue" variant="light" radius="sm" size={34}>
                    <Cpu size={18} />
                  </ThemeIcon>
                  <Stack gap={4}>
                    <Group gap="xs" wrap="wrap">
                      <Text fw={650}>node {node.id}</Text>
                      <Badge variant="outline" color="gray">
                        {node.cpuCount} cores
                      </Badge>
                      <Badge
                        variant="light"
                        color="teal"
                        leftSection={<MemoryStick size={12} />}
                      >
                        {formatBytes(node.memoryBytes)}
                      </Badge>
                      <NodeMemoryBadges node={node} />
                    </Group>
                    <Text c="dimmed" size="xs">
                      cpus {node.cpus || "—"}
                    </Text>
                  </Stack>
                </Group>
                <Group gap={6} wrap="wrap" justify="flex-end">
                  {gpus.length === 0 ? (
                    <Text c="dimmed" size="xs">
                      no GPUs
                    </Text>
                  ) : (
                    gpus.map((gpu) => (
                      <Badge key={gpu.id} variant="light" color="grape">
                        {formatAcceleratorName(gpu)}
                      </Badge>
                    ))
                  )}
                </Group>
              </Group>
            </Paper>
          );
        })}
        {unmapped.length > 0 && (
          <Text c="dimmed" size="xs">
            Unmapped GPUs (no NUMA affinity reported):{" "}
            {unmapped.map((gpu) => `GPU ${gpu.id}`).join(", ")}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
