import type { WorkloadIndexStatus } from "@arriero/core";
import { Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getWorkloadIndexStatus } from "../../api/client";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";
import { WorkloadProfilePanel } from "../workload/WorkloadProfilePanel";
import { WorkloadSessionDetail } from "../workload/WorkloadSessionDetail";
import { WorkloadSessionsPanel } from "../workload/WorkloadSessionsPanel";
import {
  defaultWorkloadScope,
  type WorkloadScopeState,
  type WorkloadTimeRange,
} from "../workload/workload-scope";

function indexStatusLine(status: WorkloadIndexStatus | undefined): string {
  if (!status) {
    return "Loading index…";
  }
  if (status.records === 0) {
    return status.lastPassAt
      ? `No captured requests indexed yet · checked ${formatLocalDateTime(status.lastPassAt)}`
      : "The index has not run yet";
  }
  return `${countLabel(status.records, "indexed request")} · ${formatLocalDateTime(status.oldestAt)} – ${formatLocalDateTime(status.newestAt)}`;
}

export function ProxyWorkloadView(props: {
  subpath: string;
  setSubpath: (next: string) => void;
}) {
  const [head = "", encodedSessionId = ""] = props.subpath.split("/");
  const view = head === "sessions" ? "sessions" : "profile";
  const sessionId = encodedSessionId
    ? decodeURIComponent(encodedSessionId)
    : null;
  const [scope, setScope] = useState<WorkloadScopeState>(defaultWorkloadScope);
  const [windowRange, setWindowRange] = useState<WorkloadTimeRange | null>(
    null,
  );
  const statusQuery = useQuery({
    queryKey: ["workload-index-status"],
    queryFn: getWorkloadIndexStatus,
    refetchInterval: 30_000,
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <SegmentedControl
          value={view}
          data={[
            { value: "profile", label: "Profile" },
            { value: "sessions", label: "Sessions" },
          ]}
          onChange={(next) => props.setSubpath(next)}
        />
        <Text size="sm" c="dimmed">
          {indexStatusLine(statusQuery.data?.data)}
        </Text>
      </Group>
      {view === "profile" && (
        <WorkloadProfilePanel
          scope={scope}
          onScopeChange={setScope}
          onOpenWindow={(range) => {
            setWindowRange(range);
            props.setSubpath("sessions");
          }}
        />
      )}
      {view === "sessions" && sessionId !== null && (
        <WorkloadSessionDetail
          sessionId={sessionId}
          onBack={() => props.setSubpath("sessions")}
        />
      )}
      {view === "sessions" && sessionId === null && (
        <WorkloadSessionsPanel
          scope={scope}
          onScopeChange={setScope}
          windowRange={windowRange}
          onClearWindow={() => setWindowRange(null)}
          onOpenSession={(id) =>
            props.setSubpath(`sessions/${encodeURIComponent(id)}`)
          }
        />
      )}
    </Stack>
  );
}
