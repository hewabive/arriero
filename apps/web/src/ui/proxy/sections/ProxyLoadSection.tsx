import type {
  ApiProxyTargetRecord,
  ApiProxyTargetRuntime,
} from "@arriero/core";
import {
  Badge,
  Box,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";

import {
  runtimeDetails,
  runtimeStateColor,
  runtimeStateLabel,
} from "../display";
import { DetailBadge } from "./DetailBadge";
import { InflightRequests } from "./InflightRequests";

function isBusy(runtime: ApiProxyTargetRuntime) {
  return runtime.activeRequests > 0 || runtime.state === "loading";
}

function targetKindLabel(runtime: ApiProxyTargetRuntime) {
  if (runtime.kind === "managed-instance") {
    return `managed: ${runtime.instanceId ?? "unresolved"}`;
  }
  return "external API";
}

function TargetCard(props: { name: string; runtime: ApiProxyTargetRuntime }) {
  const { name, runtime } = props;
  return (
    <Paper withBorder p="sm" radius="sm" w={280}>
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={700} style={{ wordBreak: "break-word" }}>
              {name}
            </Text>
            <Text c="dimmed" size="xs">
              {targetKindLabel(runtime)}
            </Text>
          </Stack>
          <Box style={{ flexShrink: 0 }}>
            <DetailBadge
              color={runtimeStateColor(runtime.state, runtime.activeRequests)}
              label={runtimeStateLabel(runtime.state, runtime.activeRequests)}
              detail={runtime.stateDetail}
            />
          </Box>
        </Group>
        <Group gap={4} wrap="nowrap" align="center">
          <Text c="dimmed" size="xs">
            model
          </Text>
          {runtime.model ? (
            <Code>{runtime.model}</Code>
          ) : (
            <Text c="dimmed" size="xs" fs="italic">
              process default
            </Text>
          )}
        </Group>
        <Stack gap={2}>
          {runtimeDetails(runtime).map((detail) => (
            <Text key={detail} c="dimmed" size="xs">
              {detail}
            </Text>
          ))}
        </Stack>
        <InflightRequests inflight={runtime.inflight} />
      </Stack>
    </Paper>
  );
}

export function ProxyLoadSection(props: {
  runtime: ApiProxyTargetRuntime[];
  targetById: Map<string, ApiProxyTargetRecord>;
  refreshing: boolean;
}) {
  if (props.runtime.length === 0) {
    return null;
  }
  const busy = props.runtime.filter(isBusy).length;
  const activeRequests = props.runtime.reduce(
    (sum, runtime) => sum + runtime.activeRequests,
    0,
  );

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <div className="section-heading">
            <Group gap="xs" align="center">
              <Text fw={700} size="lg">
                Proxy load
              </Text>
              {props.refreshing && <Loader size={12} />}
            </Group>
            <Text c="dimmed" size="sm">
              Live per-target state, current stage and in-flight output
            </Text>
          </div>
          <Group gap="xs">
            <Badge color="orange" variant="light">
              {busy} busy
            </Badge>
            <Badge color="blue" variant="light">
              {activeRequests} active req
            </Badge>
          </Group>
        </Group>
        <Group gap="xs" align="stretch">
          {props.runtime.map((runtime) => (
            <TargetCard
              key={runtime.targetId}
              name={
                props.targetById.get(runtime.targetId)?.name ?? runtime.targetId
              }
              runtime={runtime}
            />
          ))}
        </Group>
      </Stack>
    </Paper>
  );
}
