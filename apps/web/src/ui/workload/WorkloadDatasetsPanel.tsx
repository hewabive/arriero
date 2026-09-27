import type { WorkloadDatasetSummary } from "@arriero/core";
import {
  Anchor,
  Button,
  FileButton,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2, Upload } from "lucide-react";

import {
  deleteWorkloadDataset,
  importWorkloadDataset,
  listWorkloadDatasets,
  workloadDatasetExportUrl,
} from "../../api/client";
import { formatBytes } from "../utils/models";
import { notifyError } from "../utils/notify";
import { formatLocalDateTime } from "../utils/time";

function windowsLabel(dataset: WorkloadDatasetSummary): string {
  const [first] = dataset.windows;
  if (!first) {
    return "—";
  }
  return dataset.windows.length === 1
    ? formatLocalDateTime(first.from)
    : `${formatLocalDateTime(first.from)} and ${dataset.windows.length - 1} more`;
}

export function WorkloadDatasetsPanel(props: {
  onOpenDataset: (datasetId: string) => void;
}) {
  const queryClient = useQueryClient();
  const datasetsQuery = useQuery({
    queryKey: ["workload-datasets"],
    queryFn: listWorkloadDatasets,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["workload-datasets"] });
  const importMutation = useMutation({
    mutationFn: importWorkloadDataset,
    onSuccess: (response) => {
      notifications.show({
        color: "green",
        title: response.data.imported
          ? "Dataset imported"
          : "Dataset already present",
        message: response.data.id.slice(0, 12),
      });
      void refresh();
    },
    onError: notifyError("Import failed"),
  });
  const deleteMutation = useMutation({
    mutationFn: deleteWorkloadDataset,
    onSuccess: () => void refresh(),
    onError: notifyError("Delete failed"),
  });
  const datasets = datasetsQuery.data?.data ?? [];

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Title order={4}>Datasets</Title>
          <FileButton
            accept=".gz,application/gzip"
            onChange={(file) => {
              if (file) {
                importMutation.mutate(file);
              }
            }}
          >
            {(buttonProps) => (
              <Button
                {...buttonProps}
                size="xs"
                variant="light"
                leftSection={<Upload size={14} />}
                loading={importMutation.isPending}
              >
                Import
              </Button>
            )}
          </FileButton>
        </Group>
        <Text size="sm" c="dimmed">
          A dataset is a frozen window of recorded sessions. Retention never
          removes it, and an exported file carries it to another machine.
        </Text>
        {datasets.length === 0 && !datasetsQuery.isLoading && (
          <Text size="sm" c="dimmed">
            No datasets yet. Pick a window on the profile, open its sessions and
            freeze it.
          </Text>
        )}
        {datasets.length > 0 && (
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Window</Table.Th>
                  <Table.Th>Model</Table.Th>
                  <Table.Th>Segments</Table.Th>
                  <Table.Th>Requests</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {datasets.map((dataset) => (
                  <Table.Tr key={dataset.id}>
                    <Table.Td>
                      <Anchor
                        component="button"
                        size="sm"
                        onClick={() => props.onOpenDataset(dataset.id)}
                      >
                        {dataset.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{windowsLabel(dataset)}</Table.Td>
                    <Table.Td>{dataset.modelId ?? "All models"}</Table.Td>
                    <Table.Td>
                      {dataset.segments} ({dataset.primedSegments} primed)
                    </Table.Td>
                    <Table.Td>{dataset.records}</Table.Td>
                    <Table.Td>{formatBytes(dataset.bytes)}</Table.Td>
                    <Table.Td>
                      {formatLocalDateTime(dataset.createdAt)}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Button
                          component="a"
                          href={workloadDatasetExportUrl(dataset.id)}
                          download
                          size="compact-xs"
                          variant="subtle"
                          leftSection={<Download size={12} />}
                        >
                          Export
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          leftSection={<Trash2 size={12} />}
                          loading={
                            deleteMutation.isPending &&
                            deleteMutation.variables === dataset.id
                          }
                          onClick={() => {
                            if (
                              window.confirm(`Delete dataset ${dataset.name}?`)
                            ) {
                              deleteMutation.mutate(dataset.id);
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Paper>
  );
}
