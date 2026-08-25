import type { PublicProxyModel } from "@arriero/core";
import {
  Alert,
  Badge,
  EmptyState,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import { getPublicStatus } from "../../api/client";
import { countLabel } from "../utils/plural";

function modelLoadStateColor(value: PublicProxyModel["status"]["value"]) {
  switch (value) {
    case "loaded":
      return "green";
    case "partial":
      return "teal";
    case "loading":
      return "blue";
    case "failed":
      return "red";
    default:
      return "gray";
  }
}

function ProxyModelCard(props: { model: PublicProxyModel }) {
  const { status, modelId } = props.model;
  const details = [countLabel(status.activeRequests, "active request")];
  if (status.queuedRequests > 0) {
    details.push(`${status.queuedRequests} queued`);
  }
  return (
    <Paper withBorder p="sm" radius="sm" w={260}>
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Text fw={700} style={{ wordBreak: "break-word" }}>
            {modelId}
          </Text>
          <Badge
            color={modelLoadStateColor(status.value)}
            variant={status.activeRequests > 0 ? "filled" : "light"}
            style={{ flexShrink: 0 }}
          >
            {status.value}
          </Badge>
        </Group>
        <Stack gap={2}>
          {details.map((detail) => (
            <Text key={detail} c="dimmed" size="xs">
              {detail}
            </Text>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

export function PublicStatusView() {
  const statusQuery = useQuery({
    queryKey: ["public-status"],
    queryFn: getPublicStatus,
    refetchInterval: 5_000,
  });
  const status = statusQuery.data?.data;

  if (statusQuery.isError) {
    return (
      <Alert color="red" icon={<AlertTriangle size={16} />}>
        {(statusQuery.error as Error).message}
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="sm">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start">
            <div className="section-heading">
              <Title order={4}>API models</Title>
              <Text c="dimmed" size="sm">
                Published models — load state aggregated over route targets
              </Text>
            </div>
            <Group gap="xs">
              <Badge color="green" variant="light">
                {status?.models.loaded ?? 0}/{status?.models.total ?? 0} loaded
              </Badge>
              <Badge color="blue" variant="light">
                {status?.models.activeRequests ?? 0} active req
              </Badge>
              {(status?.models.queuedRequests ?? 0) > 0 && (
                <Badge color="grape" variant="light">
                  {status?.models.queuedRequests ?? 0} queued
                </Badge>
              )}
              <Badge color={status?.service.authRequired ? "green" : "orange"}>
                {status?.service.authRequired ? "AUTH ON" : "AUTH OFF"}
              </Badge>
            </Group>
          </Group>

          <Group gap="xs" align="stretch">
            {(status?.models.items ?? []).map((model) => (
              <ProxyModelCard key={model.modelId} model={model} />
            ))}
            {status?.models.items.length === 0 && (
              <Paper withBorder p="md" radius="sm" w="100%">
                <EmptyState size="sm" title="No published models" />
              </Paper>
            )}
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}
