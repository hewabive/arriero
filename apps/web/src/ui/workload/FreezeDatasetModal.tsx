import type {
  WorkloadDatasetSelectionInput,
  WorkloadFreezeJob,
  WorkloadTimeRange,
} from "@arriero/core";
import {
  Alert,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  freezeWorkloadDataset,
  getWorkloadFreezeJob,
  previewWorkloadSelection,
} from "../../api/client";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";
import { workloadDatasetsQuery } from "./workload-dataset-queries";
import { formatWorkloadRange } from "./workload-scope";

function defaultName(window: WorkloadTimeRange): string {
  return `Window ${formatLocalDateTime(window.from)}`;
}

export function FreezeDatasetModal(props: {
  window: WorkloadTimeRange | null;
  population: WorkloadTimeRange;
  sourceId: string | null;
  modelId: string | null;
  onClose: () => void;
  onFrozen: (datasetId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [job, setJob] = useState<WorkloadFreezeJob | null>(null);
  const window = props.window;
  const selection: WorkloadDatasetSelectionInput | null = window
    ? {
        windows: [window],
        sourceId: props.sourceId,
        modelId: props.modelId,
      }
    : null;
  const previewQuery = useQuery({
    queryKey: ["workload-selection-preview", selection],
    queryFn: () => previewWorkloadSelection(selection ?? { windows: [] }),
    enabled: selection !== null,
  });
  const jobQuery = useQuery({
    queryKey: ["workload-freeze-job", job?.id],
    queryFn: getWorkloadFreezeJob,
    enabled: job !== null,
    refetchInterval: (query) =>
      query.state.data?.data?.status === "running" ? 500 : false,
  });
  const liveJob = jobQuery.data?.data ?? job;
  const freezeMutation = useMutation({
    mutationFn: freezeWorkloadDataset,
    onSuccess: (response) => setJob(response.data),
    onError: notifyError("Freeze failed"),
  });

  const reportedJobRef = useRef<string | null>(null);
  const { onFrozen } = props;
  const finishedJobId = liveJob?.status === "succeeded" ? liveJob.id : null;
  const finishedDatasetId =
    liveJob?.status === "succeeded" ? liveJob.datasetId : null;
  useEffect(() => {
    if (
      finishedJobId === null ||
      finishedDatasetId === null ||
      reportedJobRef.current === finishedJobId
    ) {
      return;
    }
    reportedJobRef.current = finishedJobId;
    void queryClient.invalidateQueries({
      queryKey: workloadDatasetsQuery.queryKey,
    });
    setJob(null);
    onFrozen(finishedDatasetId);
  }, [finishedJobId, finishedDatasetId, onFrozen, queryClient]);

  const preview = previewQuery.data?.data;
  const blocked = !preview || preview.problems.length > 0;
  const close = () => {
    setJob(null);
    props.onClose();
  };

  return (
    <Modal
      opened={window !== null}
      onClose={close}
      title="Freeze window into a dataset"
      size="lg"
    >
      {window && (
        <Stack gap="sm">
          <Text size="sm">{formatWorkloadRange(window.from, window.to)}</Text>
          {preview && (
            <Text size="sm" c="dimmed">
              {countLabel(preview.segments.length, "segment")} ·{" "}
              {countLabel(preview.records, "request")} ·{" "}
              {countLabel(
                preview.segments.filter((segment) => segment.primed).length,
                "primed segment",
              )}
            </Text>
          )}
          {preview?.problems.map((problem) => (
            <Alert key={problem} color="red" variant="light">
              {problem}
            </Alert>
          ))}
          {preview?.warnings.map((warning) => (
            <Alert key={warning} color="yellow" variant="light">
              {warning}
            </Alert>
          ))}
          <TextInput
            label="Name"
            placeholder={defaultName(window)}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Textarea
            label="Description"
            autosize
            minRows={2}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          {liveJob?.status === "running" && (
            <Text size="sm" c="dimmed">
              Freezing {liveJob.processedRecords} of {liveJob.totalRecords}…
            </Text>
          )}
          {liveJob?.status === "failed" && (
            <Alert color="red" variant="light">
              {liveJob.error ?? "The freeze failed"}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={blocked}
              loading={
                freezeMutation.isPending || liveJob?.status === "running"
              }
              onClick={() =>
                selection &&
                freezeMutation.mutate({
                  name: name.trim() || defaultName(window),
                  description,
                  selection,
                  population: props.population,
                })
              }
            >
              Freeze
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
