import {
  apiProxyInflightPhaseEnded,
  type ApiProxyInflightControlAction,
  type ApiProxyInflightControlAvailability,
  type ApiProxyInflightControlResult,
  type ApiProxyInflightControls,
  type ApiProxyTargetRuntime,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Eye, FastForward, Square } from "lucide-react";
import { useEffect, useState } from "react";

import {
  controlApiProxyInflight,
  getApiProxyInflightDetail,
} from "../../../api/client";
import {
  inflightLabel,
  inflightPhaseColor,
  inflightPrefillPercent,
  inflightTimings,
} from "../display";
import { notifyError } from "../../utils/notify";

function InflightAction(props: {
  tooltip: string;
  ariaLabel: string;
  color: string;
  Icon: typeof Square;
  fullLabel: string;
  full?: boolean | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  armed?: boolean | undefined;
  onClick: () => void;
}) {
  const { Icon } = props;
  const loading = props.loading ?? false;
  const disabled = props.disabled ?? false;
  const disabledAttr = disabled ? { "data-disabled": true } : {};
  const handleClick = (event: React.MouseEvent) => {
    if (disabled || loading) {
      event.preventDefault();
      return;
    }
    props.onClick();
  };
  if (props.full) {
    return (
      <Tooltip label={props.tooltip}>
        <Button
          size="compact-xs"
          variant={props.armed ? "filled" : "light"}
          color={props.color}
          leftSection={<Icon size={13} />}
          loading={loading}
          {...disabledAttr}
          onClick={handleClick}
        >
          {props.fullLabel}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={props.tooltip}>
      <ActionIcon
        size="xs"
        variant={props.armed ? "filled" : "subtle"}
        color={props.color}
        aria-label={props.ariaLabel}
        loading={loading}
        {...disabledAttr}
        onClick={handleClick}
      >
        <Icon size={13} />
      </ActionIcon>
    </Tooltip>
  );
}

type InflightControlMeta = {
  color: string;
  okColor: string;
  label: string;
  ariaLabel: string;
  tooltip: string;
  Icon: typeof Square;
  controlKey: keyof ApiProxyInflightControls;
  confirm: boolean;
  pending: string;
  errorTitle: string;
  statusMessages: Partial<
    Record<ApiProxyInflightControlResult["status"], string>
  >;
  rejectedFallback: string;
  unavailableTooltip: (
    reason: ApiProxyInflightControlAvailability["reason"],
  ) => string;
};

const INFLIGHT_CONTROL_ACTIONS: readonly ApiProxyInflightControlAction[] = [
  "force-answer",
  "finish",
  "cancel",
];

function stopUnavailableTooltip(
  reason: ApiProxyInflightControlAvailability["reason"],
): string {
  return `Action unavailable: ${reason ?? "unknown reason"}`;
}

const INFLIGHT_CONTROL_META: Record<
  ApiProxyInflightControlAction,
  InflightControlMeta
> = {
  "force-answer": {
    color: "orange",
    okColor: "violet",
    label: "Force answer",
    ariaLabel: "Interrupt thinking, force answer",
    tooltip: "Interrupt thinking → force answer",
    Icon: FastForward,
    controlKey: "forceAnswer",
    confirm: false,
    pending: "Forcing the model to write its answer…",
    errorTitle: "Interrupt failed",
    statusMessages: {
      "too-late": "Already answering — nothing left to interrupt.",
      "not-ready": "No reasoning captured yet — try again in a moment.",
      "not-supported": "This target does not support forced answers.",
    },
    rejectedFallback: "The target rejected the control request.",
    unavailableTooltip: (reason) =>
      reason === "not-ready"
        ? "Force answer — waiting for model reasoning"
        : reason === "too-late"
          ? "Force answer — the model is already answering"
          : "This target does not support forced answers",
  },
  finish: {
    color: "teal",
    okColor: "teal",
    label: "Finish",
    ariaLabel: "Stop now, keep the answer generated so far",
    tooltip: "Stop now, keep the answer generated so far",
    Icon: Square,
    controlKey: "finish",
    confirm: false,
    pending: "Finishing — returning the answer generated so far…",
    errorTitle: "Finish failed",
    statusMessages: {},
    rejectedFallback: "The finish action is not available.",
    unavailableTooltip: stopUnavailableTooltip,
  },
  cancel: {
    color: "red",
    okColor: "red",
    label: "Cancel",
    ariaLabel: "Cancel the request, discard the response",
    tooltip: "Cancel the request, discard the response",
    Icon: Ban,
    controlKey: "cancel",
    confirm: true,
    pending: "Cancelling the request…",
    errorTitle: "Cancel failed",
    statusMessages: {},
    rejectedFallback: "The cancel action is not available.",
    unavailableTooltip: stopUnavailableTooltip,
  },
};

function controlStatusMessage(
  meta: InflightControlMeta,
  result: ApiProxyInflightControlResult,
): string {
  if (result.status === "ok") {
    return meta.pending;
  }
  if (result.status === "not-found") {
    return "Request already finished.";
  }
  return (
    meta.statusMessages[result.status] ??
    result.message ??
    meta.rejectedFallback
  );
}

function InflightControlButton({
  id,
  action,
  controls,
  finished,
  full,
}: {
  id: string;
  action: ApiProxyInflightControlAction;
  controls: ApiProxyInflightControls;
  finished?: boolean | undefined;
  full?: boolean | undefined;
}) {
  const queryClient = useQueryClient();
  const meta = INFLIGHT_CONTROL_META[action];
  const control = controls[meta.controlKey];
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const mutation = useMutation({
    mutationFn: () => controlApiProxyInflight(id, action),
    onSuccess: async (result) => {
      const status = result.data.status;
      notifications.show({
        color: status === "ok" ? meta.okColor : "yellow",
        message: controlStatusMessage(meta, result.data),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["api-proxy-runtime"] }),
        queryClient.invalidateQueries({ queryKey: ["api-proxy-inflight", id] }),
      ]);
    },
    onError: notifyError(meta.errorTitle),
  });
  return (
    <InflightAction
      tooltip={
        finished
          ? "Request already finished"
          : !control.available
            ? meta.unavailableTooltip(control.reason)
            : armed
              ? "Click again to confirm"
              : meta.tooltip
      }
      ariaLabel={meta.ariaLabel}
      color={meta.color}
      Icon={meta.Icon}
      fullLabel={armed ? "Confirm cancel" : meta.label}
      full={full}
      disabled={finished || !control.available}
      loading={mutation.isPending}
      armed={armed}
      onClick={() => {
        if (meta.confirm && !armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        mutation.mutate();
      }}
    />
  );
}

function InflightViewButton({
  hasOutput,
  onOpen,
}: {
  hasOutput: boolean;
  onOpen: () => void;
}) {
  return (
    <InflightAction
      tooltip={hasOutput ? "View output" : "No output captured yet"}
      ariaLabel="View output"
      color="violet"
      Icon={Eye}
      fullLabel="View output"
      disabled={!hasOutput}
      onClick={onOpen}
    />
  );
}

function InflightDetailModal({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: ["api-proxy-inflight", id],
    queryFn: () => getApiProxyInflightDetail(id as string),
    enabled: id !== null,
    retry: false,
    refetchInterval: (query) => {
      const phase = query.state.data?.data.phase;
      return id !== null &&
        query.state.status !== "error" &&
        !(phase && apiProxyInflightPhaseEnded(phase))
        ? 700
        : false;
    },
  });
  const detail = detailQuery.data?.data;
  const finished = detail ? apiProxyInflightPhaseEnded(detail.phase) : false;
  return (
    <Modal
      opened={id !== null}
      onClose={onClose}
      title="In-flight output"
      size="xl"
    >
      {detailQuery.isLoading && <Loader size="sm" />}
      {!detail && detailQuery.isError && (
        <Text size="sm" c="dimmed">
          Request finished — no live output to show.
        </Text>
      )}
      {detail && (
        <Stack gap="sm">
          <Group gap="xs" wrap="wrap" justify="space-between">
            <Group gap="xs" wrap="wrap">
              <Badge color={inflightPhaseColor(detail.phase)} variant="light">
                {detail.phase}
              </Badge>
              <Badge color="gray" variant="light">
                {detail.protocol}
              </Badge>
              <Text size="xs" c="dimmed">
                {detail.modelId}
              </Text>
              <Text size="xs" c="dimmed">
                {detail.reasoningChars} reasoning chars ·{" "}
                {detail.completionTokens} answer tok
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {INFLIGHT_CONTROL_ACTIONS.map((action) => (
                <InflightControlButton
                  key={action}
                  id={detail.id}
                  action={action}
                  controls={detail.controls}
                  finished={finished}
                  full
                />
              ))}
            </Group>
          </Group>
          {detailQuery.isError && (
            <Text size="xs" c="dimmed">
              Request finished — showing last captured output.
            </Text>
          )}
          {(detail.reasoningText ||
            (!detail.answerText && detail.toolCalls.length === 0)) && (
            <Stack gap={2}>
              <Text size="xs" fw={600} c="violet">
                Reasoning
                {detail.reasoningTruncated ? " (truncated, latest shown)" : ""}
              </Text>
              <ScrollArea.Autosize mah="45vh">
                <Code block style={{ whiteSpace: "pre-wrap" }}>
                  {detail.reasoningText || "—"}
                </Code>
              </ScrollArea.Autosize>
            </Stack>
          )}
          {detail.answerText && (
            <Stack gap={2}>
              <Text size="xs" fw={600} c="teal">
                Answer
                {detail.answerTruncated ? " (truncated, latest shown)" : ""}
              </Text>
              <ScrollArea.Autosize mah="25vh">
                <Code block style={{ whiteSpace: "pre-wrap" }}>
                  {detail.answerText}
                </Code>
              </ScrollArea.Autosize>
            </Stack>
          )}
          {detail.toolCalls.length > 0 && (
            <Stack gap={2}>
              <Text size="xs" fw={600} c="grape">
                Tool calls ({detail.toolCalls.length})
              </Text>
              <ScrollArea.Autosize mah="35vh">
                <Stack gap={6}>
                  {detail.toolCalls.map((call, index) => (
                    <Stack key={index} gap={2}>
                      <Text size="xs" fw={600} ff="monospace">
                        {call.name ?? "(unnamed)"}
                      </Text>
                      <Code block style={{ whiteSpace: "pre-wrap" }}>
                        {call.arguments || "—"}
                      </Code>
                    </Stack>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </Stack>
          )}
        </Stack>
      )}
    </Modal>
  );
}

export function InflightRequests({
  inflight,
}: {
  inflight: ApiProxyTargetRuntime["inflight"];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (inflight.length === 0) {
    return null;
  }
  return (
    <>
      <Stack gap={4} mt={2}>
        {inflight.map((req) => {
          const percent = inflightPrefillPercent(req);
          const label = inflightLabel(req);
          const timings = inflightTimings(req);
          const hasOutput =
            req.reasoningChars > 0 || req.answerChars > 0 || req.toolCalls > 0;
          const finished = apiProxyInflightPhaseEnded(req.phase);
          return (
            <Stack
              key={req.id}
              gap={2}
              style={finished ? { opacity: 0.6 } : undefined}
            >
              <Group
                gap={6}
                wrap="nowrap"
                justify="space-between"
                align="flex-start"
              >
                <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                  <Badge
                    size="xs"
                    color={inflightPhaseColor(req.phase)}
                    variant="light"
                  >
                    {req.phase}
                  </Badge>
                  {label && (
                    <Text size="xs" c="dimmed">
                      {label}
                    </Text>
                  )}
                </Group>
                <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                  <InflightViewButton
                    hasOutput={hasOutput}
                    onOpen={() => setOpenId(req.id)}
                  />
                  {INFLIGHT_CONTROL_ACTIONS.map((action) => (
                    <InflightControlButton
                      key={action}
                      id={req.id}
                      action={action}
                      controls={req.controls}
                      finished={finished}
                    />
                  ))}
                </Group>
              </Group>
              {timings && (
                <Text size="xs" c="dimmed">
                  {timings}
                </Text>
              )}
              {percent !== null && (
                <Progress
                  size="xs"
                  value={percent}
                  color={inflightPhaseColor(req.phase)}
                  aria-label="prefill progress"
                />
              )}
            </Stack>
          );
        })}
      </Stack>
      <InflightDetailModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
