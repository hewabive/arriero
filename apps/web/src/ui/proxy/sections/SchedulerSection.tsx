import type { ApiProxyPlanPreview, ApiProxyTargetRecord } from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Activity, Play } from "lucide-react";

import { TouchSelect } from "../../components/TouchCombobox";
import { formatLocalDateTime } from "../../utils/time";
import { actionLabels } from "../display";
import type { SelectOption } from "./types";
import { countLabel } from "../../utils/plural";

type SchedulerSectionProps = {
  targetOptions: SelectOption[];
  requestTargetId: string | null;
  planPreview: ApiProxyPlanPreview | undefined;
  targetById: Map<string, ApiProxyTargetRecord>;
  previewPending: boolean;
  onRequestTargetChange: (targetId: string | null) => void;
  onPreviewRequest: () => void;
};

function SchedulerActionTable(props: {
  actions: ApiProxyPlanPreview["plan"]["actions"];
  targetById: Map<string, ApiProxyTargetRecord>;
  emptyText: string;
  keyPrefix: string;
}) {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table striped verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Action</Table.Th>
            <Table.Th>Target</Table.Th>
            <Table.Th>Model / slot</Table.Th>
            <Table.Th>Reason</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.actions.map((action, index) => (
            <Table.Tr
              key={`${props.keyPrefix}-${action.type}-${action.targetId}-${index}`}
            >
              <Table.Td>{actionLabels[action.type]}</Table.Td>
              <Table.Td>
                {props.targetById.get(action.targetId)?.name ?? action.targetId}
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm">{action.model ?? "process action"}</Text>
                  {action.slotId !== null && (
                    <Text c="dimmed" size="xs">
                      slot {action.slotId}
                    </Text>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{action.reason}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
          {props.actions.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={4}>
                <Text c="dimmed" ta="center" py="sm">
                  {props.emptyText}
                </Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function planStatus(preview: ApiProxyPlanPreview) {
  if (!preview.plan.ok) {
    return {
      color: "red",
      label: "blocked",
      description:
        preview.plan.blockingReason ?? "Scheduler cannot build a route plan.",
    };
  }

  const readinessActions = preview.plan.actions.filter(
    (action) => action.type !== "route-request",
  );
  if (readinessActions.length === 0) {
    return {
      color: "green",
      label: "ready now",
      description: "The request can be routed without preparation.",
    };
  }

  return {
    color: "yellow",
    label: "needs preparation",
    description: `The request is routable, but the manager must run ${countLabel(readinessActions.length, "preparation step")} first.`,
  };
}

export function SchedulerSection(props: SchedulerSectionProps) {
  const previewStatus = props.planPreview
    ? planStatus(props.planPreview)
    : null;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <Activity size={18} />
            <Title order={4}>Request plan check</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Shows what a public API request would need to do; no action is
            executed here.
          </Text>
        </Group>
        <Group align="flex-end" wrap="wrap">
          <TouchSelect
            label="Incoming request target"
            placeholder="Select target"
            data={props.targetOptions}
            value={props.requestTargetId}
            onChange={props.onRequestTargetChange}
            miw={260}
            searchable
          />
          <Button
            leftSection={<Play size={16} />}
            disabled={!props.requestTargetId}
            loading={props.previewPending}
            onClick={props.onPreviewRequest}
          >
            Check plan
          </Button>
        </Group>

        {props.planPreview && previewStatus && (
          <Stack gap="xs">
            <Group gap="xs" wrap="wrap">
              <Badge color={previewStatus.color}>{previewStatus.label}</Badge>
              <Badge variant="light">{props.planPreview.plan.mode}</Badge>
              <Text c="dimmed" size="sm">
                checked {formatLocalDateTime(props.planPreview.checkedAt)}
              </Text>
            </Group>
            {previewStatus.description && (
              <Text c={props.planPreview.plan.ok ? "dimmed" : "red"} size="sm">
                {previewStatus.description}
              </Text>
            )}
            <SchedulerActionTable
              actions={props.planPreview.plan.actions}
              targetById={props.targetById}
              emptyText="No scheduler action is needed"
              keyPrefix="preview"
            />
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
