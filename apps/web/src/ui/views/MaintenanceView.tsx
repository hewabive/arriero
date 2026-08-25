import { LOG_FILE_CATEGORIES, type LogFileCategory } from "@arriero/core";
import {
  Button,
  Group,
  NumberInput,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  getLogRetentionSettings,
  getLogStorageUsage,
  pruneLogStorage,
  updateLogRetentionSettings,
} from "../../api/client";
import { useApiProxySettings } from "../proxy/use-api-proxy-settings";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";

const CATEGORY_LABELS: Record<LogFileCategory, string> = {
  instance: "Instance runs",
  webapp: "Web app runs",
  build: "llama.cpp builds",
  env: "Python environments",
  update: "Self-updates",
  other: "Other files",
};

function LogStorageCard() {
  const queryClient = useQueryClient();
  const usageQuery = useQuery({
    queryKey: ["log-storage-usage"],
    queryFn: getLogStorageUsage,
  });
  const settingsQuery = useQuery({
    queryKey: ["log-retention-settings"],
    queryFn: getLogRetentionSettings,
  });
  const usage = usageQuery.data?.data ?? null;
  const settings = settingsQuery.data?.data ?? null;
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [maxTotalMb, setMaxTotalMb] = useState<number | "off" | null>(null);
  const saveMutation = useMutation({
    mutationFn: updateLogRetentionSettings,
    onSuccess: (result) => {
      queryClient.setQueryData(["log-retention-settings"], result);
      setRetentionDays(null);
      setMaxTotalMb(null);
      notifications.show({
        title: "Log retention",
        message: "Settings saved.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Log retention",
        message: (error as Error).message,
      }),
  });
  const pruneMutation = useMutation({
    mutationFn: pruneLogStorage,
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["log-storage-usage"] }),
        queryClient.invalidateQueries({ queryKey: ["api-proxy-traces"] }),
      ]);
      const pruned = result.data;
      notifications.show({
        title: "Prune finished",
        message: `${countLabel(pruned.deletedFiles, "log file")} deleted (${formatBytes(
          pruned.freedBytes,
        )} freed), ${countLabel(pruned.prunedTraces, "proxy trace")} and ${countLabel(
          pruned.prunedRequestDirs,
          "request artifact",
        )} pruned.`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Prune failed",
        message: (error as Error).message,
      }),
  });

  const categories = usage
    ? [...usage.categories].sort(
        (a, b) =>
          LOG_FILE_CATEGORIES.indexOf(a.category) -
          LOG_FILE_CATEGORIES.indexOf(b.category),
      )
    : [];
  const effectiveRetentionDays = retentionDays ?? settings?.retentionDays ?? 30;
  const effectiveMaxTotal = maxTotalMb ?? settings?.maxTotalMb ?? "off";
  const effectiveMaxTotalValue =
    effectiveMaxTotal === "off" ? null : effectiveMaxTotal;
  const dirty =
    settings !== null &&
    (effectiveRetentionDays !== settings.retentionDays ||
      effectiveMaxTotalValue !== settings.maxTotalMb);

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Title order={4}>Log storage</Title>
          <Button
            variant="light"
            onClick={() => pruneMutation.mutate()}
            loading={pruneMutation.isPending}
          >
            Prune now
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          Run logs of instances and web apps plus build, environment and
          self-update logs under the managed logs directory. Files older than
          the retention age are deleted hourly; logs of running processes and
          the latest run of every instance and web app are always kept. The
          optional size cap removes the oldest deletable files once the
          directory outgrows it. Prune now also applies the proxy request
          history retention below.
        </Text>
        {usage && (
          <Table verticalSpacing={4}>
            <Table.Tbody>
              {categories.map((entry) => (
                <Table.Tr key={entry.category}>
                  <Table.Td>{CATEGORY_LABELS[entry.category]}</Table.Td>
                  <Table.Td>{countLabel(entry.files, "file")}</Table.Td>
                  <Table.Td>{formatBytes(entry.bytes)}</Table.Td>
                </Table.Tr>
              ))}
              <Table.Tr>
                <Table.Td fw={600}>Total</Table.Td>
                <Table.Td fw={600}>
                  {countLabel(usage.totalFiles, "file")}
                </Table.Td>
                <Table.Td fw={600}>{formatBytes(usage.totalBytes)}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        )}
        {usage?.oldestFileAt && (
          <Text size="sm" c="dimmed">
            Oldest log file: {new Date(usage.oldestFileAt).toLocaleString()}
          </Text>
        )}
        <Group align="flex-end" gap="sm" wrap="wrap">
          <NumberInput
            label="Retention (days)"
            min={1}
            max={3650}
            value={effectiveRetentionDays}
            onChange={(value) =>
              setRetentionDays(typeof value === "number" ? value : null)
            }
            w={160}
          />
          <NumberInput
            label="Total size cap (MB)"
            placeholder="No cap"
            min={16}
            value={effectiveMaxTotal === "off" ? "" : effectiveMaxTotal}
            onChange={(value) =>
              setMaxTotalMb(typeof value === "number" ? value : "off")
            }
            w={200}
          />
          <Button
            onClick={() =>
              saveMutation.mutate({
                retentionDays: effectiveRetentionDays,
                maxTotalMb: effectiveMaxTotalValue,
              })
            }
            disabled={!dirty}
            loading={saveMutation.isPending}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function ProxyHistoryCard() {
  const usageQuery = useQuery({
    queryKey: ["log-storage-usage"],
    queryFn: getLogStorageUsage,
  });
  const proxyRequests = usageQuery.data?.data.proxyRequests ?? null;
  const { query, mutation, settings } = useApiProxySettings((error) =>
    notifications.show({
      color: "red",
      title: "Proxy settings",
      message: (error as Error).message,
    }),
  );
  const [draft, setDraft] = useState<number | null>(null);
  const effective = draft ?? settings?.traceRetentionDays ?? 30;
  const dirty = settings !== null && effective !== settings.traceRetentionDays;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Title order={4}>Proxy request history</Title>
        <Text size="sm" c="dimmed">
          Persisted request traces and the request/response artifacts captured
          by pipeline nodes. Both are pruned hourly past the retention age.
        </Text>
        {proxyRequests && (
          <Text size="sm">
            Captured artifacts:{" "}
            {countLabel(proxyRequests.requestDirs, "request")},{" "}
            {formatBytes(proxyRequests.bytes)}
          </Text>
        )}
        <Group align="flex-end" gap="sm" wrap="wrap">
          <NumberInput
            label="Retention (days)"
            min={1}
            max={3650}
            disabled={query.isPending}
            value={effective}
            onChange={(value) =>
              setDraft(typeof value === "number" ? value : null)
            }
            w={160}
          />
          <Button
            onClick={() =>
              mutation.mutate(
                { traceRetentionDays: effective },
                { onSuccess: () => setDraft(null) },
              )
            }
            disabled={!dirty}
            loading={mutation.isPending}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function MaintenanceView() {
  return (
    <Stack gap="md">
      <LogStorageCard />
      <ProxyHistoryCard />
    </Stack>
  );
}
