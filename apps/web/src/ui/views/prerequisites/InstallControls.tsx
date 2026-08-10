import type {
  PrerequisiteInstallCapability,
  PrerequisiteInstallRun,
  PrerequisiteInstallStart,
} from "@arriero/core";
import {
  ActionIcon,
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
import { Check, ChevronDown, Copy, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  getPrerequisiteInstallRun,
  startPrerequisiteInstall,
} from "../../../api/client";
import { formatLocalDateTime } from "../../utils/time";

export type PrerequisiteInstallControls = {
  run: PrerequisiteInstallRun | null;
  startError: Error | null;
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
    available: capability?.available ?? false,
    busy: mutation.isPending || runStatus === "running",
    start: (request) => mutation.mutate(request),
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

function installRunStatusColor(status: PrerequisiteInstallRun["status"]) {
  if (status === "running") return "blue";
  if (status === "succeeded") return "green";
  return "red";
}

export function InstallRunPanel(props: {
  run: PrerequisiteInstallRun;
  onDismiss: () => void;
}) {
  const { run, onDismiss } = props;
  const [detailsOpened, setDetailsOpened] = useState(
    run.status !== "succeeded",
  );

  useEffect(() => {
    if (run.status === "succeeded") {
      setDetailsOpened(false);
    }
  }, [run.status]);

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs" wrap="wrap">
            <Badge color={installRunStatusColor(run.status)}>
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
            <Tooltip
              label={detailsOpened ? "Collapse details" : "Expand details"}
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => setDetailsOpened((opened) => !opened)}
                aria-label={
                  detailsOpened
                    ? "Collapse install details"
                    : "Expand install details"
                }
              >
                <ChevronDown
                  size={16}
                  style={{
                    transform: detailsOpened ? "rotate(180deg)" : undefined,
                    transition: "transform 150ms ease",
                  }}
                />
              </ActionIcon>
            </Tooltip>
            {run.status !== "running" && (
              <Tooltip label="Dismiss">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={onDismiss}
                  aria-label="Dismiss install result"
                >
                  <X size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>
        <Collapse in={detailsOpened}>
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
