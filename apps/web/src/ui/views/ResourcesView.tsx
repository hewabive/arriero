import type {
  FleetResourcesEntry,
  Instance,
  MemoryPool,
  ResourcePoolUsage,
} from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  Progress,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, MemoryStick, Pencil, Save, Server } from "lucide-react";
import { useState } from "react";

import {
  getFleetResources,
  listInstances,
  updateMemoryPool,
} from "../../api/client";
import { NumaTopologyPanel } from "../components/NumaTopologyPanel";
import { formatBytes } from "../utils/models";
import { formatMemoryPoolName } from "../utils/pools";

const GIB = 1024 ** 3;

type PoolDraft = {
  name: string;
  capacityGib: number | string;
  reservedGib: number | string;
  autoCapacity: boolean;
};

type EditTarget = { pool: MemoryPool; nodeId: string };

function gib(bytes: number): number {
  return Math.round((bytes / GIB) * 100) / 100;
}

function poolIcon(kind: MemoryPool["kind"]) {
  return kind === "gpu" ? <Cpu size={18} /> : <MemoryStick size={18} />;
}

function poolColor(kind: MemoryPool["kind"]) {
  return kind === "gpu" ? "grape" : "teal";
}

function usageColor(ratio: number) {
  if (ratio >= 1) return "red";
  if (ratio >= 0.85) return "orange";
  return "blue";
}

function nodeStateBadge(entry: FleetResourcesEntry) {
  if (entry.ok) {
    return (
      <Badge color="green" variant="light">
        reachable
      </Badge>
    );
  }
  const label = entry.error ?? "unreachable";
  return (
    <Tooltip label={label}>
      <Badge color="red" variant="light">
        unreachable
      </Badge>
    </Tooltip>
  );
}

export function ResourcesView() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState<PoolDraft | null>(null);

  const fleetQuery = useQuery({
    queryKey: ["fleet-resources"],
    queryFn: getFleetResources,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const instancesQuery = useQuery({
    queryKey: ["instances"],
    queryFn: listInstances,
    staleTime: 10_000,
  });

  const entries = fleetQuery.data?.data ?? [];
  const instances = instancesQuery.data?.data ?? [];

  function residentsForPool(poolId: string) {
    return instances
      .map((instance) => {
        const draw = instance.memory.find((entry) => entry.poolId === poolId);
        return draw ? { instance, bytes: draw.bytes } : null;
      })
      .filter((value): value is { instance: Instance; bytes: number } =>
        Boolean(value),
      );
  }

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; nodeId: string; draft: PoolDraft }) =>
      updateMemoryPool(
        input.id,
        {
          name: input.draft.name.trim(),
          capacityBytes: Math.max(
            0,
            Math.round(Number(input.draft.capacityGib) * GIB),
          ),
          reservedBytes: Math.max(
            0,
            Math.round(Number(input.draft.reservedGib) * GIB),
          ),
          autoCapacity: input.draft.autoCapacity,
        },
        input.nodeId,
      ),
    onSuccess: async (result) => {
      closeEdit();
      await queryClient.invalidateQueries({ queryKey: ["fleet-resources"] });
      await queryClient.invalidateQueries({ queryKey: ["resources"] });
      notifications.show({ title: "Pool updated", message: result.data.name });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Pool update failed",
        message: (error as Error).message,
      }),
  });

  function openEdit(pool: MemoryPool, nodeId: string) {
    setEditing({ pool, nodeId });
    setDraft({
      name: pool.name,
      capacityGib: gib(pool.capacityBytes),
      reservedGib: gib(pool.reservedBytes),
      autoCapacity: pool.autoCapacity,
    });
  }

  function closeEdit() {
    setEditing(null);
    setDraft(null);
  }

  function renderPool(
    pool: MemoryPool,
    nodeId: string,
    usageByPool: Map<string, ResourcePoolUsage>,
    showResidents: boolean,
  ) {
    const usage = usageByPool.get(pool.id);
    const budget =
      usage?.budgetBytes ??
      Math.max(0, pool.capacityBytes - pool.reservedBytes);
    const used = usage?.usedBytes ?? 0;
    const available = usage?.availableBytes ?? budget;
    const ratio = budget > 0 ? used / budget : 0;
    const residents = showResidents ? residentsForPool(pool.id) : [];

    return (
      <Paper key={pool.id} withBorder p="md" radius="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start" wrap="nowrap">
            <ThemeIcon
              color={poolColor(pool.kind)}
              variant="light"
              radius="sm"
              size={34}
            >
              {poolIcon(pool.kind)}
            </ThemeIcon>
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <Text fw={650}>{formatMemoryPoolName(pool)}</Text>
                <Badge color={poolColor(pool.kind)} variant="light">
                  {pool.kind}
                </Badge>
                <Badge variant="outline" color="gray">
                  {pool.id}
                </Badge>
                {pool.autoCapacity && (
                  <Badge variant="light" color="blue">
                    auto capacity
                  </Badge>
                )}
              </Group>
              <Text c="dimmed" size="xs">
                capacity {formatBytes(pool.capacityBytes)} · reserved{" "}
                {formatBytes(pool.reservedBytes)} · budget {formatBytes(budget)}
              </Text>
            </Stack>
          </Group>
          <Tooltip label="Edit capacity & reserve">
            <Button
              variant="light"
              size="xs"
              leftSection={<Pencil size={14} />}
              onClick={() => openEdit(pool, nodeId)}
            >
              Edit
            </Button>
          </Tooltip>
        </Group>

        <Stack gap={4} mt="sm">
          <Progress
            value={Math.min(100, ratio * 100)}
            color={usageColor(ratio)}
            radius="sm"
          />
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              used {formatBytes(used)} / {formatBytes(budget)}
            </Text>
            <Text size="xs" c={available <= 0 ? "red" : "dimmed"}>
              {formatBytes(available)} available
            </Text>
          </Group>
        </Stack>

        {residents.length > 0 && (
          <Group gap={6} wrap="wrap" mt="sm">
            <Text c="dimmed" size="xs">
              Declared by
            </Text>
            {residents.map(({ instance, bytes }) => (
              <Badge key={instance.name} variant="outline" color="gray">
                {instance.name} · {formatBytes(bytes)}
              </Badge>
            ))}
          </Group>
        )}
      </Paper>
    );
  }

  function renderNode(entry: FleetResourcesEntry) {
    const detected = entry.data?.detected;
    const pools = entry.data?.pools ?? [];
    const usageByPool = new Map<string, ResourcePoolUsage>(
      (entry.data?.ledger.pools ?? []).map((usage) => [usage.poolId, usage]),
    );

    return (
      <Stack gap="sm" key={entry.nodeId}>
        <Paper withBorder p="md" radius="sm">
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap="sm" align="center" wrap="wrap">
              <ThemeIcon color="blue" variant="light" radius="sm" size={34}>
                <Server size={18} />
              </ThemeIcon>
              <Title order={4}>{entry.nodeName}</Title>
              <Badge variant="outline" color="gray">
                {entry.self ? "self" : "peer"}
              </Badge>
              {!entry.self && nodeStateBadge(entry)}
              <Badge variant="light">{pools.length} pools</Badge>
            </Group>
            {detected && (
              <Group gap="xs" wrap="wrap">
                <Badge variant="outline" color="teal">
                  RAM {formatBytes(detected.memory.totalBytes)}
                </Badge>
                <Badge variant="outline" color="grape">
                  {detected.accelerators.length} GPU
                </Badge>
              </Group>
            )}
          </Group>
        </Paper>

        {entry.ok ? (
          pools.length > 0 ? (
            <Stack gap="sm">
              {pools.map((pool) =>
                renderPool(pool, entry.nodeId, usageByPool, entry.self),
              )}
            </Stack>
          ) : (
            <Paper withBorder p="lg" radius="sm">
              <Text c="dimmed" ta="center">
                No memory pools on this node
              </Text>
            </Paper>
          )
        ) : (
          <Paper withBorder p="md" radius="sm">
            <Text c="red" size="sm">
              {entry.error ?? "node unreachable"}
            </Text>
          </Paper>
        )}

        {detected && detected.numa.nodes.length > 1 && (
          <NumaTopologyPanel resources={detected} />
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Paper withBorder p="md" radius="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs" wrap="wrap">
            <Title order={3}>Memory pools</Title>
            <Badge variant="light">{entries.length} nodes</Badge>
          </Group>
        </Group>
        <Text c="dimmed" size="sm" mt={6}>
          Budget = capacity − reserved. Instances declare a per-pool footprint;
          the scheduler keeps the sum of running instances within each budget.
          Pools are grouped per node; global identity is (node, pool).
        </Text>
      </Paper>

      {entries.length === 0 ? (
        <Paper withBorder p="lg" radius="sm">
          <Text c="dimmed" ta="center">
            {fleetQuery.isFetching ? "Loading resources..." : "No nodes"}
          </Text>
        </Paper>
      ) : (
        entries.map(renderNode)
      )}

      <Modal
        opened={Boolean(editing)}
        onClose={closeEdit}
        title={editing ? `Edit ${editing.pool.name}` : "Edit pool"}
        size="md"
      >
        {draft && (
          <Stack gap="sm">
            <TextInput
              label="Name"
              value={draft.name}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) =>
                  current ? { ...current, name: value } : current,
                );
              }}
            />
            <Switch
              label="Auto capacity (re-sync from detected hardware on startup)"
              checked={draft.autoCapacity}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setDraft((current) =>
                  current ? { ...current, autoCapacity: checked } : current,
                );
              }}
            />
            <NumberInput
              label="Capacity (GiB)"
              description={
                draft.autoCapacity
                  ? "Auto capacity is on; this value is overwritten on next startup"
                  : undefined
              }
              min={0}
              step={1}
              disabled={draft.autoCapacity}
              value={draft.capacityGib}
              onChange={(value) =>
                setDraft((current) =>
                  current ? { ...current, capacityGib: value } : current,
                )
              }
            />
            <NumberInput
              label="Reserved (GiB)"
              description="Carve-out for the OS, games and headroom"
              min={0}
              step={1}
              value={draft.reservedGib}
              onChange={(value) =>
                setDraft((current) =>
                  current ? { ...current, reservedGib: value } : current,
                )
              }
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="subtle" onClick={closeEdit}>
                Cancel
              </Button>
              <Button
                leftSection={<Save size={16} />}
                loading={updateMutation.isPending}
                disabled={!draft.name.trim()}
                onClick={() => {
                  if (editing && draft) {
                    updateMutation.mutate({
                      id: editing.pool.id,
                      nodeId: editing.nodeId,
                      draft,
                    });
                  }
                }}
              >
                Save
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
