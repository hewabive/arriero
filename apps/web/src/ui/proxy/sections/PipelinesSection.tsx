import type {
  ApiProxyPipelineRecord,
  ApiProxyTargetRecord,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { Pencil, Trash2 } from "lucide-react";

import type { ProxyUsageRef } from "../usage";
import { formatLocalDateTime } from "../../utils/time";
import { targetStatusColor } from "../display";
import { UsedByCell } from "./UsedByCell";

function pipelineEntryLabel(
  entry: ApiProxyPipelineRecord["entry"],
  targetById: Map<string, ApiProxyTargetRecord>,
  pipelineById: Map<string, ApiProxyPipelineRecord>,
) {
  if (!entry) {
    return (
      <Text c="dimmed" size="sm">
        unbound
      </Text>
    );
  }
  if (entry.type === "node") {
    return `node ${entry.id}`;
  }
  if (entry.type === "target") {
    return targetById.get(entry.id)?.name ?? entry.id;
  }
  return pipelineById.get(entry.id)?.name ?? entry.id;
}

type PipelinesSectionProps = {
  pipelines: ApiProxyPipelineRecord[];
  pipelineById: Map<string, ApiProxyPipelineRecord>;
  targetById: Map<string, ApiProxyTargetRecord>;
  usageByPipelineId: Map<string, ProxyUsageRef[]>;
  deletePending: boolean;
  onEdit: (pipeline: ApiProxyPipelineRecord) => void;
  onDelete: (id: string) => void;
};

export function PipelinesSection(props: PipelinesSectionProps) {
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Text fw={600}>Pipelines</Text>
          <Text c="dimmed" size="sm">
            Node graphs that transform and conditionally route requests to
            targets.
          </Text>
        </Group>
        <Table.ScrollContainer minWidth={980}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Used by</Table.Th>
                <Table.Th>Nodes</Table.Th>
                <Table.Th>Entry</Table.Th>
                <Table.Th>Updated</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.pipelines.map((pipeline) => (
                <Table.Tr key={pipeline.id}>
                  <Table.Td>
                    <Group gap={6} wrap="wrap">
                      <Text fw={600}>{pipeline.name}</Text>
                      <Badge
                        color={targetStatusColor(pipeline.enabled)}
                        variant="light"
                      >
                        {pipeline.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <UsedByCell
                      refs={props.usageByPipelineId.get(pipeline.id)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="wrap">
                      {pipeline.nodes.map((node) => (
                        <Badge key={node.id} variant="outline">
                          {node.type === "call"
                            ? `call: ${props.pipelineById.get(node.config.pipelineId)?.name ?? node.config.pipelineId}`
                            : node.type === "exit"
                              ? `exit: ${node.config.exitName}`
                              : node.type}
                        </Badge>
                      ))}
                      {pipeline.nodes.length === 0 && (
                        <Text c="dimmed" size="sm">
                          none
                        </Text>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {pipelineEntryLabel(
                      pipeline.entry,
                      props.targetById,
                      props.pipelineById,
                    )}
                  </Table.Td>
                  <Table.Td>{formatLocalDateTime(pipeline.updatedAt)}</Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Edit node">
                        <ActionIcon
                          aria-label="Edit proxy node"
                          variant="subtle"
                          onClick={() => props.onEdit(pipeline)}
                        >
                          <Pencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete node">
                        <ActionIcon
                          aria-label="Delete proxy node"
                          variant="subtle"
                          color="red"
                          loading={props.deletePending}
                          onClick={() => props.onDelete(pipeline.id)}
                        >
                          <Trash2 size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
              {props.pipelines.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text c="dimmed" ta="center" py="lg">
                      No pipelines configured
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Paper>
  );
}
