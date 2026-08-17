import type { HfDownloadFile, HfDownloadJob } from "@arriero/core";
import {
  Badge,
  Button,
  Collapse,
  Group,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cancelHfDownloadJob, listHfDownloadJobs } from "../../api/client";
import {
  JobPanelControls,
  useJobPanelCollapse,
} from "../components/JobPanelControls";
import { formatBytes } from "../utils/models";

function statusColor(status: HfDownloadJob["status"]) {
  if (status === "succeeded") return "green";
  if (status === "running") return "blue";
  if (status === "canceled") return "gray";
  return "red";
}

function fileStatusColor(status: HfDownloadFile["status"]) {
  if (status === "succeeded") return "green";
  if (status === "skipped") return "teal";
  if (status === "downloading") return "blue";
  if (status === "failed") return "red";
  if (status === "canceled") return "gray";
  return "gray";
}

function jobPercent(job: HfDownloadJob): number | null {
  if (job.totalBytes <= 0) {
    return null;
  }
  return Math.min(
    100,
    Math.round((job.downloadedBytes / job.totalBytes) * 100),
  );
}

function HfDownloadJobCard(props: {
  job: HfDownloadJob;
  canceling: boolean;
  onCancel: () => void;
}) {
  const { job } = props;
  const [dismissed, setDismissed] = useState(false);
  const [detailsOpened, toggleDetails] = useJobPanelCollapse(
    job.id,
    job.status === "succeeded",
  );
  if (dismissed) {
    return null;
  }
  const percent = jobPercent(job);

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ flex: "1 1 auto", minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
              <Text fw={600} size="sm">
                {job.repoId}
              </Text>
              <Badge color={statusColor(job.status)} variant="light">
                {job.status}
              </Badge>
              {percent !== null && (
                <Badge color="blue" variant="outline">
                  {percent}%
                </Badge>
              )}
              <Text size="xs" c="dimmed">
                {formatBytes(job.downloadedBytes)} /{" "}
                {formatBytes(job.totalBytes)}
              </Text>
            </Group>
            <Text c="dimmed" size="xs" style={{ overflowWrap: "anywhere" }}>
              {job.message ?? job.currentPath ?? "Waiting for progress."}
            </Text>
          </Stack>
          <Group gap={4} wrap="nowrap">
            {job.status === "running" && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<X size={14} />}
                loading={props.canceling}
                disabled={job.cancelRequested}
                onClick={props.onCancel}
              >
                {job.cancelRequested ? "Canceling" : "Cancel"}
              </Button>
            )}
            <JobPanelControls
              subject="download"
              opened={detailsOpened}
              onToggle={toggleDetails}
              onDismiss={
                job.status !== "running" ? () => setDismissed(true) : undefined
              }
            />
          </Group>
        </Group>

        <Collapse in={detailsOpened}>
          <Stack gap="xs">
            {percent !== null && (
              <Progress
                value={percent}
                color={statusColor(job.status)}
                animated={job.status === "running"}
                striped={job.status === "running"}
              />
            )}
            <ScrollArea.Autosize mah={220} type="auto" offsetScrollbars>
              <Stack gap={3}>
                {job.files.map((file) => (
                  <Group key={file.path} gap="xs" wrap="nowrap">
                    <Badge
                      color={fileStatusColor(file.status)}
                      variant="light"
                      miw={92}
                    >
                      {file.status}
                    </Badge>
                    <Text
                      size="xs"
                      style={{ overflowWrap: "anywhere", flex: "1 1 auto" }}
                    >
                      {file.path}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatBytes(file.size)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            {job.error && (
              <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>
                {job.error}
              </Text>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}

export function HfDownloadJobsPanel() {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: ["hf-download-jobs"],
    queryFn: listHfDownloadJobs,
    refetchInterval: (current) =>
      current.state.data?.data.some((job) => job.status === "running")
        ? 750
        : 5_000,
  });
  const jobs = jobsQuery.data?.data ?? [];
  const completionRef = useRef("");

  useEffect(() => {
    const key = jobs
      .filter((job) => job.status !== "running")
      .map((job) => `${job.id}:${job.status}`)
      .join(",");
    if (!key || completionRef.current === key) {
      return;
    }
    completionRef.current = key;
    void queryClient.invalidateQueries({ queryKey: ["hf-downloads"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
  }, [jobs, queryClient]);

  const cancelMutation = useMutation({
    mutationFn: (repoId: string) => cancelHfDownloadJob(repoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hf-download-jobs"] });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Cancel download",
        message: (error as Error).message,
      }),
  });

  if (jobs.length === 0) {
    return null;
  }

  return (
    <Stack gap="sm">
      {jobs.map((job) => (
        <HfDownloadJobCard
          key={job.id}
          job={job}
          canceling={
            cancelMutation.isPending && cancelMutation.variables === job.repoId
          }
          onCancel={() => cancelMutation.mutate(job.repoId)}
        />
      ))}
    </Stack>
  );
}
