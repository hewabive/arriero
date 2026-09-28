import type { ApiEndpointRecord } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { SELF_NODE_ID, absoluteUrl } from "../../api/base.js";
import { useActiveFleetNode, useActiveNode } from "../NodeContext.js";
import { countLabel } from "../utils/plural";

type ApiEndpointsSectionProps = {
  endpoints: ApiEndpointRecord[];
  targetCountByEndpointId: Map<string, number>;
  deletePending: boolean;
  onCreate: () => void;
  onEdit: (endpoint: ApiEndpointRecord) => void;
  onDelete: (id: string) => void;
};

function endpointKindLabel(endpoint: ApiEndpointRecord) {
  if (endpoint.kind === "managed-instance") {
    return endpoint.nodeId ? "remote instance" : "managed instance";
  }
  if (endpoint.kind === "manager-proxy") return "manager proxy";
  return "external API";
}

function endpointAuthLabel(endpoint: ApiEndpointRecord) {
  if (endpoint.kind !== "external-api") return "—";
  if (endpoint.apiKeyEnvVar) return `env: ${endpoint.apiKeyEnvVar}`;
  if (endpoint.authConfigured) return "key";
  return "none";
}

function useManagerProxyUrl(): string | null {
  const { activeNodeId } = useActiveNode();
  const activeFleetNode = useActiveFleetNode();
  if (activeNodeId === SELF_NODE_ID) {
    return typeof window === "undefined" ? null : absoluteUrl("/v1");
  }
  return activeFleetNode
    ? `${activeFleetNode.baseUrl.replace(/\/+$/, "")}/v1`
    : null;
}

function endpointBaseUrl(
  endpoint: ApiEndpointRecord,
  managerProxyUrl: string | null,
) {
  if (endpoint.kind !== "manager-proxy") {
    return endpoint.baseUrl;
  }
  return managerProxyUrl ?? endpoint.baseUrl;
}

export function ApiEndpointsSection(props: ApiEndpointsSectionProps) {
  const managerProxyUrl = useManagerProxyUrl();
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Badge variant="light">
            {countLabel(props.endpoints.length, "endpoint")}
          </Badge>
          <Button
            variant="light"
            leftSection={<Plus size={16} />}
            onClick={props.onCreate}
          >
            Add endpoint
          </Button>
        </Group>
        <Table.ScrollContainer minWidth={960}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Base URL</Table.Th>
                <Table.Th>Auth</Table.Th>
                <Table.Th>Usage</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.endpoints.map((endpoint) => (
                <Table.Tr key={endpoint.id}>
                  <Table.Td>
                    <Group gap={6} wrap="wrap">
                      <Text fw={600}>{endpoint.name}</Text>
                      <Badge
                        color={endpoint.enabled ? "green" : "gray"}
                        variant="light"
                      >
                        {endpoint.enabled ? "enabled" : "disabled"}
                      </Badge>
                      {endpoint.passthrough && (
                        <Badge color="violet" variant="light">
                          passthrough
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>{endpointKindLabel(endpoint)}</Table.Td>
                  <Table.Td>
                    <Code>{endpointBaseUrl(endpoint, managerProxyUrl)}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Badge color="gray" variant="light">
                      {endpointAuthLabel(endpoint)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {countLabel(
                      props.targetCountByEndpointId.get(endpoint.id) ?? 0,
                      "target",
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Tooltip
                        label={
                          endpoint.nodeId
                            ? "Remote endpoints are managed via create/delete"
                            : endpoint.editable
                              ? "Edit endpoint"
                              : "Generated endpoint"
                        }
                      >
                        <ActionIcon
                          aria-label="Edit API endpoint"
                          variant="subtle"
                          disabled={
                            !endpoint.editable || Boolean(endpoint.nodeId)
                          }
                          onClick={() => props.onEdit(endpoint)}
                        >
                          <Pencil size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip
                        label={
                          endpoint.editable
                            ? "Delete endpoint"
                            : "Generated endpoint"
                        }
                      >
                        <ActionIcon
                          aria-label="Delete API endpoint"
                          variant="subtle"
                          color="red"
                          loading={props.deletePending}
                          disabled={
                            !endpoint.editable ||
                            (props.targetCountByEndpointId.get(endpoint.id) ??
                              0) > 0
                          }
                          onClick={() => props.onDelete(endpoint.id)}
                        >
                          <Trash2 size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Paper>
  );
}
