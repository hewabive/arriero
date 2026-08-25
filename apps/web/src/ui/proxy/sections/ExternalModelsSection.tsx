import type {
  ApiEndpointRecord,
  ApiProxyModelRecord,
  ApiProxyPipelineRecord,
  ApiProxyTargetRecord,
} from "@arriero/core";
import {
  ActionIcon,
  Code,
  EmptyState,
  Group,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
  Title,
} from "@mantine/core";
import { GitBranchPlus, Pencil, Trash2, Workflow } from "lucide-react";

import { modelDirectTargetId } from "../forms";

type ExternalModelsSectionProps = {
  models: ApiProxyModelRecord[];
  pipelineById: Map<string, ApiProxyPipelineRecord>;
  targetById: Map<string, ApiProxyTargetRecord>;
  endpointById: Map<string, ApiEndpointRecord>;
  deletePending: boolean;
  createPipelinePending: boolean;
  togglePendingId: string | null;
  onEdit: (model: ApiProxyModelRecord) => void;
  onDelete: (id: string) => void;
  onOpenPipeline: (pipelineId: string) => void;
  onCreatePipeline: (model: ApiProxyModelRecord) => void;
  onSetVisible: (model: ApiProxyModelRecord, visible: boolean) => void;
  onSetEnabled: (model: ApiProxyModelRecord, enabled: boolean) => void;
};

export function ExternalModelsSection(props: ExternalModelsSectionProps) {
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Title order={4}>External models</Title>
          <Group gap="xs" wrap="wrap">
            <Code>/proxy/v1/models</Code>
            <Code>/v1/models</Code>
            <Code>/v1/responses</Code>
            <Code>/v1/messages</Code>
          </Group>
        </Group>
        <Text c="dimmed" size="sm">
          Published model IDs are shared by OpenAI-compatible and
          Anthropic-compatible public facades. OpenAI-compatible requests can
          start, load and forward through bound targets.
        </Text>
        <Table.ScrollContainer minWidth={900}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Model ID</Table.Th>
                <Table.Th>Visible</Table.Th>
                <Table.Th>Enabled</Table.Th>
                <Table.Th>Route to</Table.Th>
                <Table.Th>Owned by</Table.Th>
                <Table.Th>Description</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.models.map((model) => {
                const directTargetId = modelDirectTargetId(model);
                return (
                  <Table.Tr key={model.id}>
                    <Table.Td>
                      <Code>{model.modelId}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Listed in GET /v1/models">
                        <Switch
                          size="sm"
                          checked={model.visible}
                          disabled={props.togglePendingId === model.id}
                          aria-label={`Toggle visibility for ${model.modelId}`}
                          onChange={(event) => {
                            const visible = event.currentTarget.checked;
                            props.onSetVisible(model, visible);
                          }}
                        />
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Serves requests; off responds model_disabled">
                        <Switch
                          size="sm"
                          checked={model.enabled}
                          disabled={props.togglePendingId === model.id}
                          aria-label={`Toggle serving for ${model.modelId}`}
                          onChange={(event) => {
                            const enabled = event.currentTarget.checked;
                            props.onSetEnabled(model, enabled);
                          }}
                        />
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      {routeToLabel(
                        model.routeTo ??
                          (model.targetId
                            ? { type: "target", id: model.targetId }
                            : null),
                        props.targetById,
                        props.pipelineById,
                        props.endpointById,
                      )}
                    </Table.Td>
                    <Table.Td>{model.ownedBy}</Table.Td>
                    <Table.Td>
                      {model.description ? (
                        <Text size="sm">{model.description}</Text>
                      ) : (
                        <Text c="dimmed" size="sm">
                          none
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        {model.routeTo?.type === "pipeline" &&
                          props.pipelineById.has(model.routeTo.id) && (
                            <Tooltip label="Open pipeline">
                              <ActionIcon
                                aria-label="Open bound pipeline"
                                variant="subtle"
                                color="teal"
                                onClick={() => {
                                  const routeTo = model.routeTo;
                                  if (routeTo?.type === "pipeline") {
                                    props.onOpenPipeline(routeTo.id);
                                  }
                                }}
                              >
                                <Workflow size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        {directTargetId &&
                          props.targetById.has(directTargetId) && (
                            <Tooltip label="Create pipeline between model and target">
                              <ActionIcon
                                aria-label="Create pipeline between model and target"
                                variant="subtle"
                                color="teal"
                                loading={props.createPipelinePending}
                                onClick={() => props.onCreatePipeline(model)}
                              >
                                <GitBranchPlus size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        <Tooltip label="Edit model">
                          <ActionIcon
                            aria-label="Edit proxy model"
                            variant="subtle"
                            onClick={() => props.onEdit(model)}
                          >
                            <Pencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete model">
                          <ActionIcon
                            aria-label="Delete proxy model"
                            variant="subtle"
                            color="red"
                            loading={props.deletePending}
                            onClick={() => props.onDelete(model.id)}
                          >
                            <Trash2 size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
              {props.models.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <EmptyState
                      size="sm"
                      title="No external models configured"
                      py="lg"
                    />
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

function routeToLabel(
  routeTo: ApiProxyModelRecord["routeTo"],
  targetById: Map<string, ApiProxyTargetRecord>,
  pipelineById: Map<string, ApiProxyPipelineRecord>,
  endpointById: Map<string, ApiEndpointRecord>,
) {
  if (!routeTo) {
    return (
      <Text c="dimmed" size="sm">
        unbound
      </Text>
    );
  }
  if (routeTo.type === "target") {
    return targetById.get(routeTo.id)?.name ?? routeTo.id;
  }
  if (routeTo.type === "endpoint") {
    const name =
      endpointById.get(routeTo.endpointId)?.name ?? routeTo.endpointId;
    return routeTo.upstreamModel
      ? `endpoint · ${name} → ${routeTo.upstreamModel}`
      : `endpoint · ${name}`;
  }
  return pipelineById.get(routeTo.id)?.name ?? routeTo.id;
}
