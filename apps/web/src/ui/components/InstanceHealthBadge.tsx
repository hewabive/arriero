import type { Instance, InstanceHealthSummary } from "@arriero/core";
import { Badge, Tooltip } from "@mantine/core";

import { memoryAssessmentStatusColors } from "./instance-details-helpers";

export function statusColor(status: Instance["status"]) {
  if (status === "running") return "green";
  if (status === "starting" || status === "stopping") return "yellow";
  if (status === "stale") return "orange";
  if (status === "error") return "red";
  return "gray";
}

export function healthStatusColor(status: InstanceHealthSummary["status"]) {
  if (status === "ready") return "green";
  if (status === "starting" || status === "stopping" || status === "loading")
    return "yellow";
  if (status === "degraded" || status === "stale") return "orange";
  if (status === "invalid" || status === "error") return "red";
  return "gray";
}

export function InstanceConfigDriftBadge(props: {
  health: InstanceHealthSummary | undefined;
}) {
  if (!props.health?.configDrift) {
    return null;
  }
  return (
    <Tooltip
      label="Instance configuration changed after this process started; restart to apply it."
      withArrow
    >
      <Badge color="grape" variant="light">
        config drift
      </Badge>
    </Tooltip>
  );
}

function InstanceNumaSkewBadge(props: {
  health: InstanceHealthSummary | undefined;
}) {
  const placement = props.health?.numaPlacement;
  if (!placement || placement.even) {
    return null;
  }
  return (
    <Tooltip
      label={`Interleave instance memory is uneven: ${placement.maxNodeSharePct}% sits on one node (ideal ~${placement.idealSharePct}% across ${placement.interleaveNodeCount} nodes). Often caused by page cache (e.g. a bulk file copy) starving a node — clear it and restart.`}
      withArrow
      multiline
      w={320}
    >
      <Badge color="orange" variant="light">
        numa skew {placement.maxNodeSharePct}%
      </Badge>
    </Tooltip>
  );
}

function InstanceMemoryAssessmentBadge(props: {
  health: InstanceHealthSummary | undefined;
}) {
  const assessment = props.health?.memoryAssessment;
  if (!assessment) return null;
  const labels: Record<typeof assessment.status, string> = {
    "not-assessed": "memory not assessed",
    "update-required": "memory assessment stale",
    analytical: "memory analytical",
    verified: "memory verified",
    mismatch: "memory mismatch",
  };
  return (
    <Tooltip
      label={[assessment.reason, assessment.recommendation]
        .concat(`Reservation: ${assessment.reservationStatus}.`)
        .filter(Boolean)
        .join(" ")}
      withArrow
      multiline
      w={360}
    >
      <Badge
        color={memoryAssessmentStatusColors[assessment.status]}
        variant="light"
      >
        {labels[assessment.status]}
      </Badge>
    </Tooltip>
  );
}

export function InstanceHealthBadge(props: {
  instance: Instance;
  health: InstanceHealthSummary | undefined;
}) {
  const health = props.health;
  return (
    <>
      <Tooltip label={health?.reason ?? "Health summary is loading"} withArrow>
        <Badge
          color={
            health
              ? healthStatusColor(health.status)
              : statusColor(props.instance.status)
          }
          variant="light"
        >
          {health?.status ?? props.instance.status}
        </Badge>
      </Tooltip>
      <InstanceConfigDriftBadge health={health} />
      <InstanceNumaSkewBadge health={health} />
      <InstanceMemoryAssessmentBadge health={health} />
    </>
  );
}
