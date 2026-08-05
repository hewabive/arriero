import { Alert, Badge, Button, Group, Stack, Table, Text } from "@mantine/core";
import { AlertTriangle, Calculator } from "lucide-react";

import { formatBytes } from "../utils/models";
import { type InstanceFormController } from "./use-instance-form";

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "green",
  medium: "yellow",
  low: "gray",
};

export function InstanceFormMemoryEstimate({
  fm,
}: {
  fm: InstanceFormController;
}) {
  const result = fm.memoryEstimate;
  const poolLabel = (poolId: string) =>
    fm.memoryPoolOptions.find((option) => option.value === poolId)?.label ??
    poolId;
  const included = result
    ? [
        ["mmproj", result.estimate.mmprojBytesTotal],
        ["draft", result.estimate.draftBytesTotal],
        ["LoRA", result.estimate.loraBytesTotal],
        ["control vector", result.estimate.controlVectorBytesTotal],
        ["built-in MTP", result.estimate.selfMtpBytesTotal],
      ].filter((entry): entry is [string, number] => Number(entry[1]) > 0)
    : [];

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center" wrap="wrap">
        <Text c="dimmed" size="xs">
          Estimate the footprint from the model and current arguments
          (analytical).
        </Text>
        <Button
          variant="light"
          size="xs"
          leftSection={<Calculator size={14} />}
          disabled={!fm.canEstimateMemory}
          loading={fm.memoryEstimatePending}
          onClick={fm.runMemoryEstimate}
        >
          Estimate footprint
        </Button>
      </Group>

      {!fm.canEstimateMemory && (
        <Text c="dimmed" size="xs">
          Configure a local --model to estimate (routers and remote models are
          not supported).
        </Text>
      )}

      {fm.memoryEstimateError && (
        <Alert
          color="red"
          variant="light"
          icon={<AlertTriangle size={16} />}
          title="Estimate failed"
        >
          {fm.memoryEstimateError}
        </Alert>
      )}

      {result && (
        <Stack gap="xs">
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap="xs" align="center">
              <Text fw={600} size="sm">
                {formatBytes(result.estimate.totalBytes)} total
              </Text>
              <Badge
                color={CONFIDENCE_COLOR[result.estimate.confidence] ?? "gray"}
                variant="light"
                size="sm"
              >
                {result.estimate.confidence} confidence
              </Badge>
            </Group>
            <Button
              variant="subtle"
              size="xs"
              disabled={result.estimate.draws.length === 0}
              onClick={fm.applyEstimateAsDraws}
            >
              Apply as draws
            </Button>
          </Group>

          <Text c="dimmed" size="xs">
            ctx {result.estimate.context.nCtx} · ubatch{" "}
            {result.estimate.context.nUbatch} · KV{" "}
            {result.estimate.context.typeK}/{result.estimate.context.typeV} ·
            ngl {result.estimate.context.nGpuLayers}
          </Text>

          {included.length > 0 && (
            <Text c="dimmed" size="xs">
              incl.{" "}
              {included
                .map(([label, bytes]) => `${label} ${formatBytes(bytes)}`)
                .join(" · ")}
            </Text>
          )}

          <Table withTableBorder withColumnBorders verticalSpacing={4} fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Pool</Table.Th>
                <Table.Th>Weights</Table.Th>
                <Table.Th>KV</Table.Th>
                <Table.Th>Compute</Table.Th>
                <Table.Th>Overhead</Table.Th>
                <Table.Th>Total</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result.estimate.pools.map((pool) => (
                <Table.Tr key={pool.poolId}>
                  <Table.Td>{poolLabel(pool.poolId)}</Table.Td>
                  <Table.Td>{formatBytes(pool.weightsBytes)}</Table.Td>
                  <Table.Td>{formatBytes(pool.kvBytes)}</Table.Td>
                  <Table.Td>{formatBytes(pool.computeBytes)}</Table.Td>
                  <Table.Td>{formatBytes(pool.overheadBytes)}</Table.Td>
                  <Table.Td>
                    <Text fw={600} size="xs">
                      {formatBytes(pool.totalBytes)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {result.estimate.warnings.map((warning) => (
            <Alert
              key={warning}
              color="yellow"
              variant="light"
              icon={<AlertTriangle size={16} />}
              p="xs"
            >
              <Text size="xs">{warning}</Text>
            </Alert>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
