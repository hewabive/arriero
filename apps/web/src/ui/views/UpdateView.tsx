import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Collapse,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { UpdateFleetNode, UpdateJob, UpdateJobStep } from "@arriero/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelNodeUpdateJob,
  checkForUpdate,
  getNodeUpdateJob,
  getNodeUpdateJobLogs,
  getUpdateFleet,
  startNodeUpdate,
} from "../../api/client";
import { formatLocalDateTime } from "../utils/time";

function modeColor(mode: string): string {
  return mode === "serve" ? "teal" : mode === "dev" ? "yellow" : "gray";
}

function jobColor(status: UpdateJob["status"]): string {
  switch (status) {
    case "succeeded":
      return "teal";
    case "running":
      return "blue";
    case "failed":
      return "red";
    case "canceled":
      return "orange";
    default:
      return "gray";
  }
}

function stepColor(status: UpdateJobStep["status"]): string {
  switch (status) {
    case "succeeded":
      return "teal";
    case "running":
      return "blue";
    case "failed":
      return "red";
    default:
      return "gray";
  }
}

function isEligible(node: UpdateFleetNode): boolean {
  return Boolean(
    node.ok && node.outdated && node.version?.canUpdate && !node.version?.dirty,
  );
}

export function UpdateView() {
  const queryClient = useQueryClient();
  const [activeJobs, setActiveJobs] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFetchError, setCheckFetchError] = useState<string | null>(null);
  const autoCheckedRef = useRef(false);

  const busy = Object.keys(activeJobs).length > 0;

  const fleetQuery = useQuery({
    queryKey: ["update-fleet"],
    queryFn: () => getUpdateFleet(),
    retry: 1,
    refetchInterval: () => (busy ? 2500 : false),
  });
  const fleet = fleetQuery.data?.data;
  const upstream = fleet?.upstream ?? null;

  const runCheck = useCallback(async () => {
    setChecking(true);
    setCheckFetchError(null);
    try {
      const res = await checkForUpdate();
      setCheckFetchError(res.fetchError);
      await queryClient.invalidateQueries({ queryKey: ["update-fleet"] });
    } catch (error) {
      setCheckFetchError((error as Error).message);
    } finally {
      setChecking(false);
    }
  }, [queryClient]);

  useEffect(() => {
    if (autoCheckedRef.current) {
      return;
    }
    autoCheckedRef.current = true;
    void runCheck();
  }, [runCheck]);

  const startOne = useCallback(async (node: UpdateFleetNode) => {
    const result = await startNodeUpdate(
      node.nodeId,
      Boolean(node.version?.supervised),
    );
    setActiveJobs((prev) => ({ ...prev, [node.nodeId]: result.data.id }));
  }, []);

  const onJobSettled = useCallback(
    (nodeId: string) => {
      setActiveJobs((prev) => {
        if (!(nodeId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["update-fleet"] });
    },
    [queryClient],
  );

  const startNode = useCallback(
    (node: UpdateFleetNode) => {
      setActionError(null);
      startOne(node).catch((error) => setActionError((error as Error).message));
    },
    [startOne],
  );

  const eligible = (fleet?.nodes ?? []).filter(isEligible);

  const startAll = useCallback(async () => {
    setActionError(null);
    const peers = eligible.filter((node) => !node.self);
    const selves = eligible.filter((node) => node.self);
    try {
      for (const node of peers) {
        await startOne(node);
      }
      for (const node of selves) {
        await startOne(node);
      }
    } catch (error) {
      setActionError((error as Error).message);
    }
  }, [eligible, startOne]);

  return (
    <Stack gap="md">
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={600}>Remote</Text>
              {upstream ? (
                <>
                  <Text size="sm" c="dimmed">
                    {upstream.ref ?? "upstream"}
                  </Text>
                  <Code>{upstream.shortCommit}</Code>
                  {upstream.committedAt && (
                    <Text size="sm" c="dimmed">
                      · {formatLocalDateTime(upstream.committedAt)}
                    </Text>
                  )}
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  not checked yet
                </Text>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {checking
                ? "checking…"
                : upstream?.lastCheckedAt
                  ? `checked ${formatLocalDateTime(upstream.lastCheckedAt)}`
                  : "never checked"}
            </Text>
          </Stack>
          <Group gap="xs">
            <Button
              variant="default"
              loading={checking}
              onClick={() => void runCheck()}
            >
              Check for updates
            </Button>
            <Button
              color="blue"
              disabled={eligible.length === 0}
              onClick={() => void startAll()}
            >
              Update all ({eligible.length})
            </Button>
          </Group>
        </Group>
        {checkFetchError && (
          <Alert color="yellow" mt="sm" variant="light">
            git fetch reported: {checkFetchError}
          </Alert>
        )}
        {actionError && (
          <Alert color="red" mt="sm" variant="light">
            {actionError}
          </Alert>
        )}
      </Card>

      {fleetQuery.isLoading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      ) : (
        <Stack gap="xs">
          {(fleet?.nodes ?? []).map((node) => (
            <NodeUpdateCard
              key={node.nodeId}
              node={node}
              activeJobId={activeJobs[node.nodeId] ?? null}
              onStart={startNode}
              onSettled={onJobSettled}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function disabledReason(node: UpdateFleetNode): string | null {
  if (!node.ok) {
    return node.error ?? "unreachable";
  }
  if (node.version?.dirty) {
    return "working tree is dirty";
  }
  if (!node.version?.canUpdate) {
    return node.version?.updateBlockedReason ?? "update unavailable";
  }
  if (!node.outdated) {
    return "already up to date";
  }
  return null;
}

function NodeUpdateCard({
  node,
  activeJobId,
  onStart,
  onSettled,
}: {
  node: UpdateFleetNode;
  activeJobId: string | null;
  onStart: (node: UpdateFleetNode) => void;
  onSettled: (nodeId: string) => void;
}) {
  const [logsOpen, logs] = useDisclosure(false);
  const version = node.version;
  const supervised = Boolean(version?.supervised);

  const jobQuery = useQuery({
    queryKey: ["update-job", node.nodeId, activeJobId],
    queryFn: () => getNodeUpdateJob(node.nodeId, activeJobId!),
    enabled: Boolean(activeJobId),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.data.status === "running" ? 1500 : false,
  });
  const job = jobQuery.data?.data ?? null;

  const isRestarting = Boolean(
    job &&
    job.willRestart &&
    job.status === "running" &&
    (job.currentStep === "restart" || jobQuery.isError),
  );
  const applied = Boolean(
    job &&
    job.fromCommit &&
    version?.commit &&
    version.commit !== job.fromCommit,
  );
  const settled =
    job !== null &&
    (applied ||
      (job.status === "succeeded" && !job.willRestart) ||
      job.status === "failed" ||
      job.status === "canceled");

  useEffect(() => {
    if (activeJobId && settled) {
      onSettled(node.nodeId);
    }
  }, [activeJobId, settled, node.nodeId, onSettled]);

  const logsQuery = useQuery({
    queryKey: ["update-logs", node.nodeId, activeJobId],
    queryFn: () => getNodeUpdateJobLogs(node.nodeId, activeJobId!),
    enabled: Boolean(activeJobId) && logsOpen,
    retry: 1,
    refetchInterval: () =>
      logsOpen && job?.status === "running" && !isRestarting ? 1500 : false,
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelNodeUpdateJob(node.nodeId, activeJobId!),
  });

  const reason = disabledReason(node);
  const updating = Boolean(activeJobId) && !settled;

  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs">
          <Text fw={600}>{node.nodeName}</Text>
          {node.self && (
            <Badge size="sm" variant="light" color="gray">
              self
            </Badge>
          )}
          {version && (
            <Badge size="sm" variant="light" color={modeColor(version.mode)}>
              {version.mode}
            </Badge>
          )}
          {version && !supervised && version.mode === "serve" && (
            <Tooltip label="no supervisor; update will not auto-restart">
              <Badge size="sm" variant="outline" color="gray">
                unsupervised
              </Badge>
            </Tooltip>
          )}
          {version?.dirty && (
            <Badge size="sm" variant="light" color="red">
              dirty
            </Badge>
          )}
        </Group>

        <Group gap="sm">
          {!node.ok ? (
            <Tooltip label={node.error ?? "unreachable"} multiline maw={320}>
              <Text size="sm" c="red">
                unreachable
              </Text>
            </Tooltip>
          ) : node.outdated ? (
            <Group gap={6}>
              <Code>{version?.shortCommit ?? "?"}</Code>
              {version?.committedAt && (
                <Text size="xs" c="dimmed">
                  {formatLocalDateTime(version.committedAt)}
                </Text>
              )}
              <Text size="sm" c="orange" fw={600}>
                {node.behindCount === null
                  ? "behind"
                  : `behind ${node.behindCount}`}
              </Text>
            </Group>
          ) : (
            <Text size="sm" c="teal">
              up to date
            </Text>
          )}

          {updating ? (
            <Badge color={jobColor(job?.status ?? "running")} variant="light">
              {isRestarting ? "restarting…" : (job?.currentStep ?? "starting…")}
            </Badge>
          ) : (
            <Tooltip
              label={reason ?? ""}
              disabled={!reason}
              multiline
              maw={320}
            >
              <Button
                size="xs"
                color={supervised ? "blue" : "yellow"}
                disabled={reason !== null}
                onClick={() => onStart(node)}
              >
                {supervised ? "Update & restart" : "Update"}
              </Button>
            </Tooltip>
          )}
        </Group>
      </Group>

      {activeJobId && job && (
        <Stack gap={6} mt="sm">
          {applied && (
            <Text size="sm" c="teal">
              updated to {version?.shortCommit}
            </Text>
          )}
          {job.status === "succeeded" && !job.willRestart && (
            <Text size="sm" c="teal">
              built; restart the node to apply
            </Text>
          )}
          {job.error && (
            <Text size="sm" c="red">
              {job.error}
            </Text>
          )}
          <Group gap={6}>
            {job.steps.map((step) => (
              <Badge
                key={step.name}
                size="sm"
                variant="outline"
                color={stepColor(step.status)}
              >
                {step.name}
              </Badge>
            ))}
            <Button size="compact-xs" variant="subtle" onClick={logs.toggle}>
              {logsOpen ? "hide log" : "log"}
            </Button>
            {job.status === "running" && !isRestarting && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                loading={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
              >
                cancel
              </Button>
            )}
          </Group>
          <Collapse in={logsOpen}>
            <ScrollArea h={220} type="auto" offsetScrollbars>
              <Stack gap={2}>
                {logsQuery.data?.data.lines.map((line, index) => (
                  <Code key={`${node.nodeId}-${index}`} block>
                    {line}
                  </Code>
                ))}
                {(!logsQuery.data ||
                  logsQuery.data.data.lines.length === 0) && (
                  <Text c="dimmed" size="sm" ta="center" py="md">
                    no log output yet
                  </Text>
                )}
              </Stack>
            </ScrollArea>
          </Collapse>
        </Stack>
      )}
    </Card>
  );
}
