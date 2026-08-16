import type {
  ApiProxyActivityModel,
  ApiProxyActivitySource,
} from "@arriero/core";
import {
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import { getApiProxyActivity } from "../../api/client";
import { countLabel } from "../utils/plural";

function sourceTooltip(source: ApiProxyActivitySource) {
  const parts = [`${countLabel(source.requests, "request")} in the last hour`];
  if (source.errors > 0) {
    parts.push(`${source.errors} failed`);
  }
  if (source.activeRequests > 0) {
    parts.push(`${source.activeRequests} active now`);
  }
  return parts.join(", ");
}

function SourceChip(props: { source: ApiProxyActivitySource }) {
  const { source } = props;
  const active = source.activeRequests > 0;
  const name = source.sourceName ?? "anonymous";
  return (
    <Tooltip label={sourceTooltip(source)}>
      <Badge
        variant={active ? "filled" : "light"}
        color={active ? "green" : "gray"}
        size="sm"
        tt="none"
      >
        {name} · {source.requests}
        {active ? ` · ${source.activeRequests} active` : ""}
      </Badge>
    </Tooltip>
  );
}

function ActivityModelRow(props: { model: ApiProxyActivityModel }) {
  const { model } = props;
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between" wrap="wrap">
        <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
          <Text fw={600} size="sm" style={{ wordBreak: "break-word" }}>
            {model.modelId}
          </Text>
          {model.activeRequests > 0 && (
            <Badge color="green" variant="light" size="sm" tt="none">
              {model.activeRequests} active
            </Badge>
          )}
          {model.queuedRequests > 0 && (
            <Badge color="yellow" variant="light" size="sm" tt="none">
              {model.queuedRequests} queued
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <Text c="dimmed" size="xs">
            {countLabel(model.requests, "request")}
          </Text>
          {model.errors > 0 && (
            <Text c="red" size="xs">
              {countLabel(model.errors, "error")}
            </Text>
          )}
        </Group>
      </Group>
      {model.sources.length > 0 && (
        <Group gap={6}>
          {model.sources.map((source) => (
            <SourceChip key={source.sourceId ?? "anonymous"} source={source} />
          ))}
        </Group>
      )}
    </Stack>
  );
}

export function ProxyActivityCard() {
  const activityQuery = useQuery({
    queryKey: ["api-proxy-activity"],
    queryFn: getApiProxyActivity,
    refetchInterval: 5_000,
  });
  const models = activityQuery.data?.data.models ?? [];

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <div className="section-heading">
          <Title order={4}>API activity</Title>
          <Text c="dimmed" size="sm">
            Models requested through the proxy in the last hour, with the API
            keys that called them
          </Text>
        </div>
        {models.length === 0 ? (
          <Text c="dimmed" size="sm">
            No API requests in the last hour
          </Text>
        ) : (
          <Stack gap="sm">
            {models.map((model) => (
              <ActivityModelRow key={model.modelId} model={model} />
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
