import {
  ActionIcon,
  Button,
  Divider,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";

import { formatBytes } from "../utils/models";
import { InstanceFormMemoryEstimate } from "./InstanceFormMemoryEstimate";
import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormMemorySection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  const hasPools = fm.memoryPoolOptions.length > 0;

  function availableHint(poolId: string): string | null {
    const usage = fm.memoryLedger.find((entry) => entry.poolId === poolId);
    return usage ? `${formatBytes(usage.availableBytes)} free` : null;
  }

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div>
            <Text fw={600} size="sm">
              Memory footprint
            </Text>
            <Text c="dimmed" size="xs">
              Declare how much this instance draws from each pool; the scheduler
              keeps running instances within each pool budget.
            </Text>
          </div>
          <Button
            variant="light"
            size="xs"
            leftSection={<Plus size={14} />}
            disabled={!hasPools}
            onClick={fm.addMemoryRow}
          >
            Add pool
          </Button>
        </Group>

        {!hasPools && (
          <Text c="dimmed" size="xs">
            No memory pools configured yet. Detected hardware is seeded on the
            Resources page.
          </Text>
        )}

        {fm.kind === "ktransformers" && (
          <Text c="orange" size="xs">
            Start requires a positive host reservation and one positive GPU
            reservation for every CUDA device selected by tensor parallelism.
          </Text>
        )}

        {fm.memoryRows.map((row) => {
          const hint = row.poolId ? availableHint(row.poolId) : null;
          return (
            <Group key={row.id} gap="xs" align="flex-end" wrap="nowrap">
              <Select
                label="Pool"
                placeholder="Select pool"
                data={fm.memoryPoolOptions}
                value={row.poolId || null}
                onChange={(value) =>
                  fm.updateMemoryRow(row.id, { poolId: value ?? "" })
                }
                style={{ flex: 1 }}
              />
              <NumberInput
                label="GiB"
                min={0}
                step={1}
                value={row.gib}
                onChange={(value) => fm.updateMemoryRow(row.id, { gib: value })}
                description={hint ?? undefined}
                style={{ width: 140 }}
              />
              <Tooltip label="Remove">
                <ActionIcon
                  aria-label="Remove memory pool draw"
                  color="red"
                  variant="subtle"
                  onClick={() => fm.removeMemoryRow(row.id)}
                >
                  <Trash2 size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          );
        })}

        {!fm.isWorker && (
          <>
            <Divider my="xs" />
            <InstanceFormMemoryEstimate fm={fm} />
          </>
        )}
      </Stack>
    </Paper>
  );
}
