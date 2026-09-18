import type {
  PrerequisiteInstallCapability,
  PrerequisiteInstallRun,
  PrerequisiteInstallStart,
} from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Badge,
  Code,
  Collapse,
  CopyButton,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Play, Square } from "lucide-react";
import { useEffect, useRef } from "react";

import {
  cancelPrerequisiteInstall,
  getPrerequisiteInstallRun,
  startPrerequisiteInstall,
} from "../../../api/client";
import {
  JobPanelControls,
  useJobPanelCollapse,
} from "../../components/JobPanelControls";
import { backgroundJobStatusColor } from "../../utils/job-status";
import { formatLocalDateTime } from "../../utils/time";

export type PrerequisiteInstallControls = {
  run: PrerequisiteInstallRun | null;
  startError: Error | null;
  cancelError: Error | null;
  cancelling: boolean;
  cancel: () => void;
  available: boolean;
  busy: boolean;
  start: (request: PrerequisiteInstallStart) => void;
};

export function usePrerequisiteInstall(
  capability: PrerequisiteInstallCapability | undefined,
): PrerequisiteInstallControls {
  const queryClient = useQueryClient();
  const runQuery = useQuery({
    queryKey: ["prerequisites-install-run"],
    queryFn: getPrerequisiteInstallRun,
    refetchInterval: (query) =>
      query.state.data?.data?.status === "running" ? 1000 : false,
  });
  const run = runQuery.data?.data ?? null;
  const watchedRunRef = useRef<string | null>(null);

  const mutation = useMutation({
    mutationFn: startPrerequisiteInstall,
    onSuccess: (response) => {
      watchedRunRef.current = response.data.id;
      queryClient.setQueryData(["prerequisites-install-run"], response);
    },
    onSettled: () => {
      void runQuery.refetch();
    },
  });

  const runId = run?.id ?? null;
  const cancelMutation = useMutation({
    mutationFn: cancelPrerequisiteInstall,
    onSuccess: (response) => {
      queryClient.setQueryData(["prerequisites-install-run"], response);
    },
    onSettled: () => {
      void runQuery.refetch();
    },
  });
  const runStatus = run?.status ?? null;
  useEffect(() => {
    if (runStatus === "running") {
      watchedRunRef.current = runId;
      return;
    }
    if (runId && watchedRunRef.current === runId) {
      watchedRunRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ["prerequisites"] });
    }
  }, [runId, runStatus, queryClient]);

  return {
    run,
    startError: mutation.isError ? (mutation.error as Error) : null,
    cancelError: cancelMutation.isError ? cancelMutation.error : null,
    cancelling: cancelMutation.isPending,
    cancel: () => cancelMutation.mutate(),
    available: capability?.available ?? false,
    busy: mutation.isPending || runStatus === "running",
    start: (request) => {
      cancelMutation.reset();
      mutation.mutate(request);
    },
  };
}

export function CommandBlock(props: {
  command: string;
  install?: PrerequisiteInstallControls;
  request?: PrerequisiteInstallStart;
}) {
  const { command, install, request } = props;
  return (
    <Group gap="xs" align="center" wrap="nowrap">
      <Code
        block
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {command}
      </Code>
      {install?.available && request && (
        <Tooltip label="Run on this host">
          <ActionIcon
            variant="filled"
            color="teal"
            onClick={() => install.start(request)}
            disabled={install.busy}
            aria-label="Run on this host"
          >
            <Play size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      <CopyButton value={command} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy command"}>
            <ActionIcon
              variant="subtle"
              color={copied ? "green" : "gray"}
              onClick={copy}
              aria-label="Copy command"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

export function InstallRunPanel(props: {
  run: PrerequisiteInstallRun;
  install: PrerequisiteInstallControls;
  onDismiss: () => void;
}) {
  const { run, install, onDismiss } = props;
  const [detailsOpened, toggleDetails] = useJobPanelCollapse(
    run.id,
    run.status === "succeeded",
  );

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs" wrap="wrap">
            <Badge color={backgroundJobStatusColor(run.status)}>
              {run.status}
            </Badge>
            {run.status === "running" && <Loader size="xs" />}
            <Text size="sm" fw={600}>
              Tool installation
            </Text>
            <Text size="xs" c="dimmed">
              started {formatLocalDateTime(run.startedAt)}
              {run.exitCode !== null ? ` — exit code ${run.exitCode}` : ""}
            </Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            {run.status === "running" && (
              <Tooltip label="Cancel installation">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  loading={install.cancelling}
                  onClick={install.cancel}
                  aria-label="Cancel installation"
                >
                  <Square size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            <JobPanelControls
              subject="install"
              opened={detailsOpened}
              onToggle={toggleDetails}
              onDismiss={run.status !== "running" ? onDismiss : undefined}
            />
          </Group>
        </Group>
        {install.cancelError && (
          <Alert color="red" title="Could not cancel the installation">
            {install.cancelError.message}
          </Alert>
        )}
        <Collapse expanded={detailsOpened}>
          <Stack gap="xs">
            <Code
              block
              style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {run.command}
            </Code>
            {run.log && (
              <Code
                block
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 320,
                  overflowY: "auto",
                }}
              >
                {run.log}
              </Code>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
