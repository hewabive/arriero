import type {
  LlamaCapabilitiesResult,
  LlamaCapability,
  LlamaCapabilityCategory,
} from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { RefreshCw } from "lucide-react";

import { formatLocalDateTime } from "../utils/time";

const categoryLabels: Record<LlamaCapabilityCategory, string> = {
  runtime: "Runtime",
  models: "Models",
  generation: "Generation",
  tokens: "Tokens",
  embeddings: "Embeddings",
};

function statusColor(status: LlamaCapability["status"]) {
  if (status === "available") return "green";
  if (status === "unsupported") return "yellow";
  return "red";
}

function statusLabel(status: LlamaCapability["status"]) {
  if (status === "available") return "available";
  if (status === "unsupported") return "unsupported";
  return "error";
}

function categoryCounts(capabilities: LlamaCapability[]) {
  return Object.entries(categoryLabels).map(([category, label]) => {
    const items = capabilities.filter((item) => item.category === category);
    const available = items.filter(
      (item) => item.status === "available",
    ).length;
    return {
      category: category as LlamaCapabilityCategory,
      label,
      available,
      total: items.length,
    };
  });
}

export function LlamaCapabilitiesPanel(props: {
  data: LlamaCapabilitiesResult | null;
  loading: boolean;
  error: string | null;
  disabledReason?: string | null;
  onRefresh: () => void;
}) {
  const capabilities = props.data?.capabilities ?? [];

  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" mb="xs" align="flex-start">
        <Stack gap={2}>
          <Text fw={600} size="sm">
            API capabilities
          </Text>
          <Text c="dimmed" size="xs">
            Lightweight endpoint checks without running full generation.
          </Text>
        </Stack>
        <Button
          leftSection={<RefreshCw size={14} />}
          disabled={Boolean(props.disabledReason)}
          loading={props.loading}
          size="xs"
          variant="subtle"
          onClick={props.onRefresh}
        >
          Refresh
        </Button>
      </Group>

      {props.data && (
        <Group gap="xs" mb="xs">
          <Badge variant="outline">{props.data.baseUrl}</Badge>
          {props.data.model && (
            <Badge color="blue" variant="light">
              model: {props.data.model}
            </Badge>
          )}
          <Text c="dimmed" size="xs">
            Checked {formatLocalDateTime(props.data.checkedAt)}
          </Text>
        </Group>
      )}

      {props.error && (
        <Text c="red" size="xs" mb="xs">
          {props.error}
        </Text>
      )}
      {props.disabledReason && (
        <Text c="dimmed" size="xs" mb="xs">
          {props.disabledReason}
        </Text>
      )}

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing="xs" mb="xs">
        {categoryCounts(capabilities).map((item) => (
          <Paper key={item.category} withBorder p="xs" radius="sm">
            <Text fw={600} size="xs">
              {item.label}
            </Text>
            <Text c="dimmed" size="xs">
              {item.available}/{item.total} available
            </Text>
          </Paper>
        ))}
      </SimpleGrid>

      <Table.ScrollContainer minWidth={760}>
        <Table striped highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Capability</Table.Th>
              <Table.Th>Endpoint</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Latency</Table.Th>
              <Table.Th>Reason</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {capabilities.map((capability) => (
              <Table.Tr key={capability.id}>
                <Table.Td>
                  <Stack gap={2}>
                    <Text fw={600} size="xs">
                      {capability.label}
                    </Text>
                    <Text c="dimmed" size="xs">
                      {categoryLabels[capability.category]}
                    </Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" className="code-wrap">
                    {capability.method} {capability.endpoint}
                  </Text>
                  {capability.model && (
                    <Text c="dimmed" size="xs" lineClamp={1}>
                      model: {capability.model}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Badge color={statusColor(capability.status)} variant="light">
                    {statusLabel(capability.status)}
                  </Badge>
                  {capability.httpStatus !== null && (
                    <Text c="dimmed" size="xs" mt={4}>
                      HTTP {capability.httpStatus}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{capability.latencyMs} ms</Text>
                </Table.Td>
                <Table.Td>
                  <Text
                    c={capability.status === "error" ? "red" : "dimmed"}
                    lineClamp={3}
                    size="xs"
                  >
                    {capability.reason ?? "-"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
            {capabilities.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text c="dimmed" ta="center">
                    No capability data yet
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
