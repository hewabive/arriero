import type {
  ApiEndpointRecord,
  ApiProxyTargetRecord,
  ApiProxyTargetRuntime,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Box,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { Pencil, SlidersHorizontal, Trash2 } from "lucide-react";

import type { ProxyUsageRef } from "../usage";
import {
  runtimeDetails,
  runtimeStateColor,
  runtimeStateLabel,
} from "../display";
import type { SelectOption } from "./types";
import { DetailBadge } from "./DetailBadge";
import { InflightRequests } from "./InflightRequests";
import { UsedByCell } from "./UsedByCell";

type ProxyTargetsSectionProps = {
  targets: ApiProxyTargetRecord[];
  endpointById: Map<string, ApiEndpointRecord>;
  usageByTargetId: Map<string, ProxyUsageRef[]>;
  instanceOptions: SelectOption[];
  runtimeByTargetId: Map<string, ApiProxyTargetRuntime>;
  runtimeRefreshing: boolean;
  deletePending?: boolean;
  onEdit?: (target: ApiProxyTargetRecord) => void;
  onDelete?: (id: string) => void;
};

export function ProxyTargetsSection(props: ProxyTargetsSectionProps) {
  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Text c="dimmed" size="sm">
            Targets describe which instance/model can receive proxied traffic.
          </Text>
          <Tooltip label="Refreshing runtime state">
            <Box
              h={16}
              w={16}
              style={{
                alignItems: "center",
                display: "inline-flex",
                justifyContent: "center",
              }}
            >
              {props.runtimeRefreshing && <Loader size={12} />}
            </Box>
          </Tooltip>
        </Group>
        <Table.ScrollContainer minWidth={1160}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Used by</Table.Th>
                <Table.Th>Endpoint</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th>Priority</Table.Th>
                <Table.Th>Policy</Table.Th>
                <Table.Th>Runtime</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.targets.map((target) => {
                const runtime = props.runtimeByTargetId.get(target.id);
                const endpoint = props.endpointById.get(target.endpointId);
                return (
                  <Table.Tr key={target.id}>
                    <Table.Td>
                      <Group gap={6} wrap="wrap">
                        <Text fw={600}>{target.name}</Text>
                        <Badge variant="outline">{target.role}</Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <UsedByCell refs={props.usageByTargetId.get(target.id)} />
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text size="sm">
                          {endpoint?.name ?? target.endpointId}
                        </Text>
                        <Code>
                          {endpoint?.baseUrl ?? runtime?.baseUrl ?? "missing"}
                        </Code>
                        <Text c="dimmed" size="xs">
                          {runtime?.kind === "managed-instance"
                            ? `managed: ${
                                props.instanceOptions.find(
                                  (option) =>
                                    option.value === runtime.instanceId,
                                )?.label ?? runtime.instanceId
                              }`
                            : runtime
                              ? "external API"
                              : "not resolved yet"}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {target.model ? (
                        <Code>{target.model}</Code>
                      ) : (
                        <Text c="dimmed" size="sm">
                          process default
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{target.priority}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {target.preemptible ? "preemptible" : "protected"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        <Group gap={6} wrap="wrap">
                          <DetailBadge
                            color={runtimeStateColor(
                              runtime?.state,
                              runtime?.activeRequests,
                            )}
                            label={runtimeStateLabel(
                              runtime?.state,
                              runtime?.activeRequests,
                            )}
                            detail={runtime?.stateDetail}
                          />
                        </Group>
                        {runtimeDetails(runtime).map((detail) => (
                          <Text key={detail} c="dimmed" size="xs">
                            {detail}
                          </Text>
                        ))}
                        {runtime && (
                          <InflightRequests inflight={runtime.inflight} />
                        )}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        {props.onEdit && (
                          <Tooltip label="Edit target">
                            <ActionIcon
                              aria-label="Edit proxy target"
                              variant="subtle"
                              onClick={() => props.onEdit?.(target)}
                            >
                              <Pencil size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        {props.onDelete && (
                          <Tooltip label="Delete target">
                            <ActionIcon
                              aria-label="Delete proxy target"
                              variant="subtle"
                              color="red"
                              loading={props.deletePending ?? false}
                              onClick={() => props.onDelete?.(target.id)}
                            >
                              <Trash2 size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        {!props.onEdit && (
                          <Tooltip label="Configure on Routing">
                            <ActionIcon
                              aria-label="Configure target on Routing"
                              variant="subtle"
                              component="a"
                              href="#/routing"
                            >
                              <SlidersHorizontal size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
              {props.targets.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={8}>
                    <Text c="dimmed" ta="center" py="lg">
                      No proxy targets configured
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
