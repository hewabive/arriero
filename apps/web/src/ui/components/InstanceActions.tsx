import type {
  Instance,
  InstanceHealthSummary,
  ResourceAdmission,
} from "@arriero/core";
import {
  ActionIcon,
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Copy,
  ExternalLink,
  Pencil,
  RotateCcw,
  Square,
  Trash2,
  Triangle,
} from "lucide-react";
import { useState } from "react";

import {
  ApiError,
  deleteInstance,
  instanceAction,
  startInstance,
} from "../../api/client";
import {
  canOpenLlamaWebUi,
  llamaServerWebUrl,
  llamaWebUiTooltip,
  openUrlInNewTab,
} from "../utils/instance-url";
import { formatBytes } from "../utils/models";

type InstanceActionName = "start" | "stop" | "restart";

function actionAllowed(
  action: InstanceActionName,
  health: InstanceHealthSummary | undefined,
) {
  if (!health) return false;
  if (action === "start") return health.actions.canStart;
  if (action === "stop") return health.actions.canStop;
  return health.actions.canRestart;
}

function actionTooltip(
  action: InstanceActionName,
  health: InstanceHealthSummary | undefined,
  pending: boolean,
) {
  if (pending) return "Action is in progress";
  if (!health) return "Health summary is loading";
  if (actionAllowed(action, health)) {
    if (action === "start") return "Start";
    if (action === "stop") return "Stop";
    return "Restart";
  }
  if ((action === "start" || action === "restart") && !health.preflight.ok) {
    const error = health.preflight.issues.find(
      (issue) => issue.level === "error",
    );
    return error?.message ?? "Preflight must pass before starting";
  }
  if (health.status === "stale") {
    return action === "stop"
      ? "Stop unmanaged stale process"
      : "Stop the stale process before starting another";
  }
  if (action === "stop") return "No running process to stop";
  if (action === "restart") return "No valid running process to restart";
  return health.reason;
}

export function InstanceActions(props: {
  instance: Instance;
  health: InstanceHealthSummary | undefined;
  onEdit: () => void;
  onDuplicate: () => void;
  onOpenDiagnostics?: () => void;
  onLaunchStarted: (instance: Instance, source: "start" | "restart") => void;
  onLaunchStopped: (instance: Instance) => void;
}) {
  const queryClient = useQueryClient();
  const health = props.health;
  const [deleteConfirmOpened, setDeleteConfirmOpened] = useState(false);
  const [startConfirm, setStartConfirm] = useState<ResourceAdmission | null>(
    null,
  );
  const [stopConfirm, setStopConfirm] = useState<{
    action: "stop" | "restart";
    message: string;
  } | null>(null);

  const actionMutation = useMutation({
    mutationFn: (variables: { action: InstanceActionName; force?: boolean }) =>
      variables.action === "start"
        ? startInstance(props.instance.name, variables.force ?? false)
        : instanceAction(
            props.instance.name,
            variables.action,
            variables.force ?? false,
          ),
    onSuccess: async (_result, variables) => {
      const action = variables.action;
      setStartConfirm(null);
      setStopConfirm(null);
      if (action === "start" || action === "restart") {
        props.onLaunchStarted(props.instance, action);
      } else {
        props.onLaunchStopped(props.instance);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["instances"] }),
        queryClient.invalidateQueries({
          queryKey: ["instances-health-summary"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-health-summary", props.instance.name],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-runtime", props.instance.name],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-llama", props.instance.name],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-status-summary", props.instance.name],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-logs", props.instance.name],
        }),
      ]);
    },
    onError: (error, variables) => {
      if (
        variables.action === "start" &&
        error instanceof ApiError &&
        error.status === 409
      ) {
        const admission =
          (error.body as { admission?: ResourceAdmission } | null)?.admission ??
          null;
        setStartConfirm(admission);
        return;
      }
      if (
        (variables.action === "stop" || variables.action === "restart") &&
        !variables.force &&
        error instanceof ApiError &&
        error.status === 409
      ) {
        setStopConfirm({
          action: variables.action,
          message: (error as Error).message,
        });
        return;
      }
      notifications.show({
        color: "red",
        title: "Action failed",
        message: (error as Error).message,
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteInstance(props.instance.name),
    onSuccess: async () => {
      setDeleteConfirmOpened(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["instances"] }),
        queryClient.invalidateQueries({
          queryKey: ["instances-health-summary"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-resource-profiles"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["instance-health-summary", props.instance.name],
        }),
      ]);
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Delete failed",
        message: (error as Error).message,
      });
    },
  });
  const startDisabled =
    actionMutation.isPending || !actionAllowed("start", health);
  const stopDisabled =
    actionMutation.isPending || !actionAllowed("stop", health);
  const restartDisabled =
    actionMutation.isPending || !actionAllowed("restart", health);
  const webUiUrl = llamaServerWebUrl(props.instance);
  const webUiDisabled = !canOpenLlamaWebUi(health, webUiUrl);

  return (
    <>
      <div
        className="instance-actions"
        onClick={(event) => event.stopPropagation()}
      >
        <Tooltip label={llamaWebUiTooltip(health, webUiUrl)}>
          <ActionIcon
            aria-label="Open server Web UI"
            variant="subtle"
            color="blue"
            disabled={webUiDisabled}
            onClick={() => {
              if (webUiUrl) {
                openUrlInNewTab(webUiUrl);
              }
            }}
          >
            <ExternalLink size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Edit">
          <ActionIcon
            aria-label="Edit instance"
            variant="subtle"
            onClick={props.onEdit}
          >
            <Pencil size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Duplicate">
          <ActionIcon
            aria-label="Duplicate instance"
            variant="subtle"
            onClick={props.onDuplicate}
          >
            <Copy size={16} />
          </ActionIcon>
        </Tooltip>
        {props.onOpenDiagnostics && (
          <Tooltip label="Diagnostics">
            <ActionIcon
              aria-label="Open diagnostics"
              variant="subtle"
              color="cyan"
              onClick={props.onOpenDiagnostics}
            >
              <Activity size={16} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip
          label={actionTooltip("start", health, actionMutation.isPending)}
        >
          <ActionIcon
            aria-label="Start instance"
            variant="subtle"
            color="green"
            disabled={startDisabled}
            onClick={() => actionMutation.mutate({ action: "start" })}
            loading={actionMutation.isPending}
          >
            <Triangle size={16} fill="currentColor" />
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label={actionTooltip("stop", health, actionMutation.isPending)}
        >
          <ActionIcon
            aria-label="Stop instance"
            variant="subtle"
            color="yellow"
            disabled={stopDisabled}
            onClick={() => actionMutation.mutate({ action: "stop" })}
            loading={actionMutation.isPending}
          >
            <Square size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip
          label={actionTooltip("restart", health, actionMutation.isPending)}
        >
          <ActionIcon
            aria-label="Restart instance"
            variant="subtle"
            disabled={restartDisabled}
            onClick={() => actionMutation.mutate({ action: "restart" })}
            loading={actionMutation.isPending}
          >
            <RotateCcw size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete">
          <ActionIcon
            aria-label="Delete instance"
            variant="subtle"
            color="red"
            onClick={() => setDeleteConfirmOpened(true)}
            loading={deleteMutation.isPending}
          >
            <Trash2 size={16} />
          </ActionIcon>
        </Tooltip>
      </div>

      <Modal
        opened={deleteConfirmOpened}
        onClose={() => setDeleteConfirmOpened(false)}
        title="Delete instance"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            This will remove the instance configuration and stop its managed
            process if one is running.
          </Text>
          <Code className="code-wrap">{props.instance.name}</Code>
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              onClick={() => setDeleteConfirmOpened(false)}
            >
              Cancel
            </Button>
            <Button
              color="red"
              leftSection={<Trash2 size={16} />}
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={Boolean(startConfirm)}
        onClose={() => setStartConfirm(null)}
        title="Start over budget?"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            Starting this instance would exceed the available memory budget:
          </Text>
          <Code className="code-wrap">{props.instance.name}</Code>
          {startConfirm?.shortfalls.map((shortfall) => (
            <Text key={shortfall.poolId} size="sm" c="orange">
              {shortfall.poolId}: needs {formatBytes(shortfall.deficitBytes)}{" "}
              more than the {formatBytes(shortfall.availableBytes)} free
            </Text>
          ))}
          <Text size="xs" c="dimmed">
            Start anyway only if the declared footprints are conservative;
            overcommitting may cause swapping or OOM.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setStartConfirm(null)}>
              Cancel
            </Button>
            <Button
              color="orange"
              leftSection={<Triangle size={16} fill="currentColor" />}
              loading={actionMutation.isPending}
              onClick={() =>
                actionMutation.mutate({ action: "start", force: true })
              }
            >
              Start anyway
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={Boolean(stopConfirm)}
        onClose={() => setStopConfirm(null)}
        title={
          stopConfirm?.action === "restart" ? "Restart anyway?" : "Stop anyway?"
        }
        centered
      >
        <Stack gap="sm">
          <Code className="code-wrap">{props.instance.name}</Code>
          <Text size="sm" c="orange">
            {stopConfirm?.message}
          </Text>
          <Text size="xs" c="dimmed">
            Forcing this will break the RPC link and crash the orchestrators
            currently using this worker. Stop them first unless they are already
            wedged.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setStopConfirm(null)}>
              Cancel
            </Button>
            <Button
              color="orange"
              loading={actionMutation.isPending}
              onClick={() => {
                if (stopConfirm) {
                  actionMutation.mutate({
                    action: stopConfirm.action,
                    force: true,
                  });
                }
              }}
            >
              {stopConfirm?.action === "restart"
                ? "Restart anyway"
                : "Stop anyway"}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
