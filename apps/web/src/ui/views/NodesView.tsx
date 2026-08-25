import type {
  FleetNodeCreate,
  FleetNodeUpdate,
  FleetNodeView,
  UpdateFleetNode,
  UpdateJob,
  UpdateJobStep,
} from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Collapse,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RotateCw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  cancelNodeUpdateJob,
  checkForUpdate,
  createNode,
  deleteNode,
  getNodeUpdateJob,
  getNodeUpdateJobLogs,
  getNodeVersion,
  getUpdateFleet,
  listNodes,
  restartNode,
  setFleetSelf,
  startNodeUpdate,
  updateNode,
} from "../../api/client";
import {
  JobPanelControls,
  useJobPanelCollapse,
} from "../components/JobPanelControls";
import { SecretInput } from "../components/SecretInput";
import { forceReloadUi } from "../utils/reload";
import { formatLocalDateTime } from "../utils/time";
import { useAutoUpdateCheck } from "../utils/use-auto-update-check";

const SELF_RELOAD_DELAY_MS = 1500;
const RESTART_POLL_MS = 1500;
const RESTART_CONFIRM_TIMEOUT_MS = 120_000;

type Draft = {
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
  clearToken: boolean;
};

type Editor = { mode: "create" } | { mode: "edit"; node: FleetNodeView };

const emptyDraft: Draft = {
  name: "",
  baseUrl: "",
  token: "",
  enabled: true,
  clearToken: false,
};

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
    node.ok &&
    (node.outdated || node.version?.buildPending) &&
    node.version?.canUpdate &&
    !node.version?.dirty,
  );
}

function reachability(
  registryNode: FleetNodeView,
  fleetNode: UpdateFleetNode | null,
): { color: string; label: string; tooltip: string | null } {
  if (registryNode.self) {
    return {
      color: "blue",
      label: "this machine",
      tooltip: "excluded from peer fan-out; requests use the direct API",
    };
  }
  if (!registryNode.enabled) {
    return { color: "gray", label: "disabled", tooltip: null };
  }
  if (!fleetNode) {
    return { color: "yellow", label: "checking", tooltip: null };
  }
  if (fleetNode.ok) {
    return { color: "green", label: "reachable", tooltip: null };
  }
  return { color: "red", label: "unreachable", tooltip: fleetNode.error };
}

function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
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
  if (!node.outdated && !node.version?.buildPending) {
    return "already up to date";
  }
  return null;
}

export function NodesView() {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [visibleJobs, setVisibleJobs] = useState<Record<string, string>>({});
  const [runningJobs, setRunningJobs] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFetchError, setCheckFetchError] = useState<string | null>(null);

  const anyJobRunning = Object.keys(runningJobs).length > 0;

  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: listNodes,
    staleTime: 10_000,
  });
  const fleetQuery = useQuery({
    queryKey: ["update-fleet"],
    queryFn: getUpdateFleet,
    retry: 1,
    refetchInterval: () => (anyJobRunning ? 2500 : 15_000),
  });

  const registryNodes = nodesQuery.data?.data ?? [];
  const fleet = fleetQuery.data?.data;
  const upstream = fleet?.upstream ?? null;
  const fleetByNodeId = useMemo(
    () => new Map((fleet?.nodes ?? []).map((entry) => [entry.nodeId, entry])),
    [fleet],
  );
  const selfNode = fleetByNodeId.get("self") ?? null;

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    await queryClient.invalidateQueries({ queryKey: ["update-fleet"] });
  }

  function reportError(title: string, error: unknown) {
    notifications.show({
      color: "red",
      title,
      message: (error as Error).message,
    });
  }

  const createMutation = useMutation({
    mutationFn: (input: FleetNodeCreate) => createNode(input),
    onSuccess: async (result) => {
      setEditor(null);
      await invalidate();
      notifications.show({ title: "Node added", message: result.data.name });
    },
    onError: (error) => reportError("Add node failed", error),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; patch: FleetNodeUpdate }) =>
      updateNode(input.id, input.patch),
    onSuccess: async (result) => {
      setEditor(null);
      await invalidate();
      notifications.show({ title: "Node updated", message: result.data.name });
    },
    onError: (error) => reportError("Update node failed", error),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNode(id),
    onSuccess: async () => {
      await invalidate();
      notifications.show({ title: "Node removed", message: "" });
    },
    onError: (error) => reportError("Remove node failed", error),
  });

  const markSelfMutation = useMutation({
    mutationFn: (nodeId: string | null) => setFleetSelf(nodeId),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) => reportError("Mark node failed", error),
  });

  const busy = createMutation.isPending || updateMutation.isPending;

  function openCreate() {
    setDraft(emptyDraft);
    setEditor({ mode: "create" });
  }

  function openEdit(node: FleetNodeView) {
    setDraft({
      name: node.name,
      baseUrl: node.baseUrl,
      token: "",
      enabled: node.enabled,
      clearToken: false,
    });
    setEditor({ mode: "edit", node });
  }

  function save() {
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    if (!name || !baseUrl) {
      return;
    }
    if (editor?.mode === "edit") {
      const patch: FleetNodeUpdate = { name, baseUrl, enabled: draft.enabled };
      if (draft.clearToken) {
        patch.token = "";
      } else if (draft.token) {
        patch.token = draft.token;
      }
      updateMutation.mutate({ id: editor.node.id, patch });
      return;
    }
    const input: FleetNodeCreate = { name, baseUrl, enabled: draft.enabled };
    if (draft.token) {
      input.token = draft.token;
    }
    createMutation.mutate(input);
  }

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

  useAutoUpdateCheck(
    Boolean(fleet),
    fleet?.upstream?.lastCheckedAt ?? null,
    runCheck,
  );

  const startOne = useCallback(async (node: UpdateFleetNode) => {
    const result = await startNodeUpdate(
      node.nodeId,
      Boolean(node.version?.supervised),
    );
    setVisibleJobs((prev) => ({ ...prev, [node.nodeId]: result.data.id }));
    setRunningJobs((prev) => ({ ...prev, [node.nodeId]: true }));
  }, []);

  const onJobSettled = useCallback(
    (nodeId: string) => {
      setRunningJobs((prev) => withoutKey(prev, nodeId));
      void queryClient.invalidateQueries({ queryKey: ["update-fleet"] });
    },
    [queryClient],
  );

  const dismissJob = useCallback((nodeId: string) => {
    setVisibleJobs((prev) => withoutKey(prev, nodeId));
  }, []);

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
            <Button leftSection={<Plus size={16} />} onClick={openCreate}>
              Add node
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

      <Text c="dimmed" size="sm">
        Peer nodes are reached through this node; their tokens are stored
        locally and never returned.
      </Text>

      <Stack gap="xs">
        {selfNode ? (
          <NodeCard
            registryNode={null}
            fleetNode={selfNode}
            jobId={visibleJobs[selfNode.nodeId] ?? null}
            onStart={startNode}
            onSettled={onJobSettled}
            onDismiss={dismissJob}
            onEdit={null}
            onDelete={null}
            onMarkSelf={null}
            deletePending={false}
          />
        ) : (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        )}
        {registryNodes.map((node) => (
          <NodeCard
            key={node.id}
            registryNode={node}
            fleetNode={fleetByNodeId.get(node.id) ?? null}
            jobId={visibleJobs[node.id] ?? null}
            onStart={startNode}
            onSettled={onJobSettled}
            onDismiss={dismissJob}
            onEdit={openEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
            onMarkSelf={(nodeId) => markSelfMutation.mutate(nodeId)}
            deletePending={
              deleteMutation.isPending && deleteMutation.variables === node.id
            }
          />
        ))}
        {registryNodes.length === 0 && (
          <Paper withBorder p="lg" radius="sm">
            <Text c="dimmed">No peer nodes registered yet.</Text>
          </Paper>
        )}
      </Stack>

      <Modal
        opened={Boolean(editor)}
        onClose={() => setEditor(null)}
        title={
          editor?.mode === "edit" ? `Edit ${editor.node.name}` : "Add node"
        }
        size="lg"
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={draft.name}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, name: value }));
            }}
          />
          <TextInput
            label="Base URL"
            placeholder="http://192.168.1.10:8787"
            value={draft.baseUrl}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, baseUrl: value }));
            }}
          />
          <SecretInput
            label="Token"
            description={
              editor?.mode === "edit"
                ? "Leave blank to keep the current token"
                : "The peer's admin password (optional if its auth is off)"
            }
            value={draft.token}
            disabled={draft.clearToken}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, token: value }));
            }}
          />
          {editor?.mode === "edit" && editor.node.hasToken && (
            <Switch
              label="Clear stored token"
              checked={draft.clearToken}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setDraft((current) => ({ ...current, clearToken: checked }));
              }}
            />
          )}
          <Switch
            label="Enabled"
            checked={draft.enabled}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setDraft((current) => ({ ...current, enabled: checked }));
            }}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!draft.name.trim() || !draft.baseUrl.trim()}
              onClick={save}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function NodeCard({
  registryNode,
  fleetNode,
  jobId,
  onStart,
  onSettled,
  onDismiss,
  onEdit,
  onDelete,
  onMarkSelf,
  deletePending,
}: {
  registryNode: FleetNodeView | null;
  fleetNode: UpdateFleetNode | null;
  jobId: string | null;
  onStart: (node: UpdateFleetNode) => void;
  onSettled: (nodeId: string) => void;
  onDismiss: (nodeId: string) => void;
  onEdit: ((node: FleetNodeView) => void) | null;
  onDelete: ((id: string) => void) | null;
  onMarkSelf: ((nodeId: string | null) => void) | null;
  deletePending: boolean;
}) {
  const [logsOpen, logs] = useDisclosure(false);
  const nodeId = fleetNode?.nodeId ?? registryNode?.id ?? "self";
  const isSelf = Boolean(fleetNode?.self);
  const version = fleetNode?.version ?? null;
  const supervised = Boolean(version?.supervised);

  const jobQuery = useQuery({
    queryKey: ["update-job", nodeId, jobId],
    queryFn: () => getNodeUpdateJob(nodeId, jobId!),
    enabled: Boolean(jobId),
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

  const [detailsOpened, toggleDetails] = useJobPanelCollapse(
    job?.id ?? null,
    Boolean(job && (job.status === "succeeded" || applied)),
  );

  useEffect(() => {
    if (jobId && settled) {
      onSettled(nodeId);
    }
  }, [jobId, settled, nodeId, onSettled]);

  useEffect(() => {
    if (!isSelf || !jobId || !applied) {
      return;
    }
    const timer = window.setTimeout(() => {
      void forceReloadUi();
    }, SELF_RELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isSelf, jobId, applied]);

  const logsQuery = useQuery({
    queryKey: ["update-logs", nodeId, jobId],
    queryFn: () => getNodeUpdateJobLogs(nodeId, jobId!),
    enabled: Boolean(jobId) && logsOpen,
    retry: 1,
    refetchInterval: () =>
      logsOpen && job?.status === "running" && !isRestarting ? 1500 : false,
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelNodeUpdateJob(nodeId, jobId!),
  });

  const queryClient = useQueryClient();
  const nodeLabel = registryNode?.name ?? fleetNode?.nodeName ?? nodeId;
  const [restartMark, setRestartMark] = useState<string | null>(null);
  const restarting = restartMark !== null;

  const restartMutation = useMutation({
    mutationFn: () => restartNode(nodeId),
    onSuccess: (result) => setRestartMark(result.data.startedAt ?? ""),
    onError: (error) =>
      notifications.show({
        color: "red",
        title: `Restart of ${nodeLabel} failed`,
        message: (error as Error).message,
      }),
  });

  const restartPoll = useQuery({
    queryKey: ["node-restart-poll", nodeId],
    queryFn: () => getNodeVersion(nodeId),
    enabled: restarting,
    retry: false,
    refetchInterval: RESTART_POLL_MS,
  });
  const polledStartedAt = restartPoll.data?.data.startedAt ?? null;

  useEffect(() => {
    if (
      restartMark === null ||
      !polledStartedAt ||
      polledStartedAt === restartMark
    ) {
      return;
    }
    setRestartMark(null);
    notifications.show({
      color: "teal",
      title: "Node restarted",
      message: nodeLabel,
    });
    void queryClient.invalidateQueries();
  }, [restartMark, polledStartedAt, nodeLabel, queryClient]);

  useEffect(() => {
    if (restartMark === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRestartMark(null);
      notifications.show({
        color: "yellow",
        title: "Restart not confirmed",
        message: `${nodeLabel} did not report a new start time; check it manually`,
      });
    }, RESTART_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [restartMark, nodeLabel]);

  const restartBlocked = !fleetNode?.ok
    ? (fleetNode?.error ?? "unreachable")
    : !supervised
      ? "no supervisor; the process would not come back after exiting"
      : null;

  const reason = fleetNode ? disabledReason(fleetNode) : null;
  const updating = Boolean(jobId) && !settled;
  const state = registryNode ? reachability(registryNode, fleetNode) : null;
  const reachBadge = state ? (
    <Badge color={state.color} variant="light">
      {state.label}
    </Badge>
  ) : null;

  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
        <Group gap="sm" align="flex-start" wrap="nowrap">
          <ThemeIcon color="blue" variant="light" radius="sm" size={34}>
            <Server size={18} />
          </ThemeIcon>
          <Stack gap={4}>
            <Group gap="xs" wrap="wrap">
              <Text fw={650}>
                {registryNode?.name ?? fleetNode?.nodeName ?? "?"}
              </Text>
              {isSelf && (
                <Badge size="sm" variant="light" color="gray">
                  self
                </Badge>
              )}
              {state &&
                (state.tooltip ? (
                  <Tooltip label={state.tooltip} multiline maw={320}>
                    {reachBadge}
                  </Tooltip>
                ) : (
                  reachBadge
                ))}
              {registryNode && (
                <Badge
                  variant={registryNode.hasToken ? "light" : "outline"}
                  color="gray"
                >
                  {registryNode.hasToken ? "token set" : "no token"}
                </Badge>
              )}
              {version && (
                <Badge
                  size="sm"
                  variant="light"
                  color={modeColor(version.mode)}
                >
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
              {version?.buildPending && (
                <Tooltip label="the checkout is ahead of the last build; run Update to rebuild and apply">
                  <Badge size="sm" variant="light" color="orange">
                    build pending
                  </Badge>
                </Tooltip>
              )}
              {version?.restartPending && (
                <Tooltip label="a newer build is on disk; restart to apply it">
                  <Badge size="sm" variant="light" color="orange">
                    restart pending
                  </Badge>
                </Tooltip>
              )}
            </Group>
            {registryNode && (
              <Text c="dimmed" size="xs">
                {registryNode.baseUrl}
              </Text>
            )}
          </Stack>
        </Group>

        <Group gap="sm" wrap="wrap" justify="flex-end">
          {fleetNode?.ok &&
            (fleetNode.outdated ? (
              <Group gap={6}>
                <Code>{version?.shortCommit ?? "?"}</Code>
                {version?.committedAt && (
                  <Text size="xs" c="dimmed">
                    {formatLocalDateTime(version.committedAt)}
                  </Text>
                )}
                <Text size="sm" c="orange" fw={600}>
                  {fleetNode.behindCount === null
                    ? "behind"
                    : `behind ${fleetNode.behindCount}`}
                </Text>
              </Group>
            ) : version?.buildPending || version?.restartPending ? null : (
              <Text size="sm" c="teal">
                up to date
              </Text>
            ))}

          {fleetNode &&
            !restarting &&
            (updating ? (
              <Badge color={jobColor(job?.status ?? "running")} variant="light">
                {isRestarting
                  ? "restarting…"
                  : (job?.currentStep ?? "starting…")}
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
                  onClick={() => onStart(fleetNode)}
                >
                  {supervised ? "Update & restart" : "Update"}
                </Button>
              </Tooltip>
            ))}

          {fleetNode &&
            !updating &&
            (restarting ? (
              <Badge color="blue" variant="light">
                restarting…
              </Badge>
            ) : (
              <Tooltip
                label={
                  restartBlocked ??
                  "Stop the process and let the supervisor bring it back (re-reads .env)"
                }
                multiline
                maw={320}
              >
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<RotateCw size={14} />}
                  disabled={restartBlocked !== null}
                  loading={restartMutation.isPending}
                  onClick={() => restartMutation.mutate()}
                >
                  Restart
                </Button>
              </Tooltip>
            ))}

          {registryNode && onMarkSelf && (
            <Tooltip
              label={
                registryNode.self
                  ? "Stop treating this entry as the local machine"
                  : "Treat this entry as the local machine; it leaves the peer fan-out"
              }
              multiline
              maw={320}
            >
              <Button
                size="xs"
                variant="subtle"
                onClick={() =>
                  onMarkSelf(registryNode.self ? null : registryNode.id)
                }
              >
                {registryNode.self ? "Unmark this machine" : "This machine"}
              </Button>
            </Tooltip>
          )}
          {registryNode && onEdit && (
            <ActionIcon
              aria-label="Edit node"
              variant="subtle"
              onClick={() => onEdit(registryNode)}
            >
              <Pencil size={16} />
            </ActionIcon>
          )}
          {registryNode && onDelete && (
            <ActionIcon
              aria-label="Remove node"
              color="red"
              variant="subtle"
              loading={deletePending}
              onClick={() => onDelete(registryNode.id)}
            >
              <Trash2 size={16} />
            </ActionIcon>
          )}
        </Group>
      </Group>

      {jobId && job && (
        <Stack gap={6} mt="sm">
          <Group justify="space-between" align="center" wrap="nowrap">
            <Group gap="xs" wrap="wrap">
              <Text fw={600} size="sm">
                Update job
              </Text>
              <Badge color={jobColor(job.status)} variant="light">
                {job.status}
              </Badge>
            </Group>
            <Group gap={4} wrap="nowrap">
              <JobPanelControls
                size="sm"
                subject="update job"
                opened={detailsOpened}
                onToggle={toggleDetails}
                onDismiss={settled ? () => onDismiss(nodeId) : undefined}
              />
            </Group>
          </Group>
          <Collapse expanded={detailsOpened}>
            <Stack gap={6}>
              {applied && (
                <Text size="sm" c="teal">
                  {isSelf
                    ? `updated to ${version?.shortCommit} — reloading UI…`
                    : `updated to ${version?.shortCommit}`}
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
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={logs.toggle}
                >
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
              <Collapse expanded={logsOpen}>
                <ScrollArea h={220} type="auto" offsetScrollbars>
                  <Stack gap={2}>
                    {logsQuery.data?.data.lines.map((line, index) => (
                      <Code key={`${nodeId}-${index}`} block>
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
          </Collapse>
        </Stack>
      )}
    </Card>
  );
}
