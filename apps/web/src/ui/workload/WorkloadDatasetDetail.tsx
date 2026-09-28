import type { WorkloadProfileWindow } from "@arriero/core";
import {
  Alert,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";

import { getWorkloadDataset, workloadDatasetExportUrl } from "../../api/client";
import { formatBytes } from "../utils/models";
import { formatLocalDateTime } from "../utils/time";
import { formatPercent, formatTokens } from "../views/benchmark-format";

const PROFILE_ROWS: Array<{
  label: string;
  value: (window: WorkloadProfileWindow) => string;
}> = [
  { label: "Requests", value: (window) => String(window.requests) },
  { label: "Sessions", value: (window) => String(window.activeSessions) },
  {
    label: "Requests in flight",
    value: (window) => window.meanInFlight.toFixed(2),
  },
  {
    label: "Prompt p50",
    value: (window) => formatTokens(window.promptTokensP50),
  },
  {
    label: "Prompt p90",
    value: (window) => formatTokens(window.promptTokensP90),
  },
  {
    label: "Fresh prefill",
    value: (window) => formatTokens(window.freshPrefillTokens),
  },
  {
    label: "Served from cache",
    value: (window) => formatPercent(window.cachedShare),
  },
  {
    label: "Answer p50",
    value: (window) => formatTokens(window.completionTokensP50),
  },
  {
    label: "Answer p90",
    value: (window) => formatTokens(window.completionTokensP90),
  },
  {
    label: "Lost cache",
    value: (window) => formatTokens(window.cacheLossTokens),
  },
];

function ProfileComparison(props: {
  profile: WorkloadProfileWindow | null;
  population: WorkloadProfileWindow | null;
}) {
  if (!props.profile) {
    return null;
  }
  return (
    <Table verticalSpacing={4} w="auto">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th>Dataset</Table.Th>
          <Table.Th>Period it came from</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {PROFILE_ROWS.map((row) => (
          <Table.Tr key={row.label}>
            <Table.Td>{row.label}</Table.Td>
            <Table.Td>
              {props.profile ? row.value(props.profile) : "—"}
            </Table.Td>
            <Table.Td>
              {props.population ? row.value(props.population) : "—"}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function WorkloadDatasetDetail(props: {
  datasetId: string;
  onBack: () => void;
}) {
  const datasetQuery = useQuery({
    queryKey: ["workload-dataset", props.datasetId],
    queryFn: () => getWorkloadDataset(props.datasetId),
  });
  const detail = datasetQuery.data?.data;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Button
          size="xs"
          variant="subtle"
          leftSection={<ArrowLeft size={14} />}
          onClick={props.onBack}
        >
          Datasets
        </Button>
        {detail && (
          <Button
            component="a"
            href={workloadDatasetExportUrl(detail.summary.id)}
            download
            size="xs"
            variant="light"
            leftSection={<Download size={14} />}
          >
            Export
          </Button>
        )}
      </Group>
      {datasetQuery.isError && (
        <Text size="sm" c="red">
          {(datasetQuery.error as Error).message}
        </Text>
      )}
      {detail && (
        <>
          <Paper withBorder p="md" radius="sm">
            <Stack gap="xs">
              <Title order={4}>{detail.summary.name}</Title>
              {detail.summary.description && (
                <Text size="sm">{detail.summary.description}</Text>
              )}
              <Text size="sm" c="dimmed">
                Created {formatLocalDateTime(detail.summary.createdAt)} ·{" "}
                {formatBytes(detail.summary.bytes)} · arriero{" "}
                {detail.meta.arrieroVersion ?? "unknown"}
              </Text>
              <Code>{detail.summary.id}</Code>
              {detail.meta.warnings.map((warning) => (
                <Alert key={warning} color="yellow" variant="light">
                  {warning}
                </Alert>
              ))}
            </Stack>
          </Paper>
          <Paper withBorder p="md" radius="sm">
            <Stack gap="sm">
              <Title order={4}>Profile</Title>
              <ProfileComparison
                profile={detail.meta.profile}
                population={detail.meta.populationProfile}
              />
            </Stack>
          </Paper>
          <Paper withBorder p="md" radius="sm">
            <Stack gap="sm">
              <Title order={4}>Segments</Title>
              <Table.ScrollContainer minWidth={760}>
                <Table striped verticalSpacing={4}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>First request</Table.Th>
                      <Table.Th>Source</Table.Th>
                      <Table.Th>Model</Table.Th>
                      <Table.Th>Requests</Table.Th>
                      <Table.Th>Primed</Table.Th>
                      <Table.Th>Largest prompt</Table.Th>
                      <Table.Th>Session</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {detail.segments.map((segment) => (
                      <Table.Tr key={segment.sessionId}>
                        <Table.Td>
                          {formatLocalDateTime(segment.firstAt)}
                        </Table.Td>
                        <Table.Td>{segment.sourceName ?? "Anonymous"}</Table.Td>
                        <Table.Td>{segment.modelId}</Table.Td>
                        <Table.Td>{segment.records}</Table.Td>
                        <Table.Td>{segment.primed ? "Yes" : "No"}</Table.Td>
                        <Table.Td>
                          {formatTokens(segment.maxPromptTokens)}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {segment.sessionId.slice(-8)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Stack>
          </Paper>
        </>
      )}
    </Stack>
  );
}
