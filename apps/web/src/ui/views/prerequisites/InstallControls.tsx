import type {
  PrerequisiteInstallCapability,
  PrerequisiteInstallRun,
  PrerequisiteInstallStart,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Code,
  CopyButton,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Play } from "lucide-react";
import { useEffect, useRef } from "react";

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

  const mutation = useMutation({
    mutationFn: startPrerequisiteInstall,
    onSettled: () => {
      void runQuery.refetch();
    },
  });

  const watchedRunRef = useRef<string | null>(null);
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

export function InstallRunPanel(props: { run: PrerequisiteInstallRun }) {
  const { run } = props;
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group gap="xs" wrap="wrap">
          <Badge color={installRunStatusColor(run.status)}>{run.status}</Badge>
          {run.status === "running" && <Loader size="xs" />}
          <Text size="sm" fw={600}>
            Tool installation
          </Text>
          <Text size="xs" c="dimmed">
            started {formatLocalDateTime(run.startedAt)}
            {run.exitCode !== null ? ` — exit code ${run.exitCode}` : ""}
          </Text>
        </Group>
        <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
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
    </Paper>
  );
}
