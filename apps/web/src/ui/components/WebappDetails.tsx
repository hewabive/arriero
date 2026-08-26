import {
  ENVIRONMENT_ENGINE_LABELS,
  webappDescriptor,
  type EnvironmentRecord,
  type Webapp,
  type WebappRunInfo,
} from "@arriero/core";
import {
  Badge,
  Code,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  getWebappLogs,
  getWebappPreflight,
  getWebappRuntime,
  listWebappRuns,
} from "../../api/client";
import { statusColor } from "./InstanceHealthBadge";
import {
  envStatusColor,
  envVersionLabel,
  WebappActionButtons,
  WebappConfigDriftBadge,
} from "./WebappActionButtons";
import { useWebappActions } from "./use-webapp-actions";
import { formatLocalDateTime } from "../utils/time";

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ta="right" className="text-wrap">
        {value}
      </Text>
    </Group>
  );
}

function runStatusBadges(run: WebappRunInfo) {
  return (
    <Group gap={4} wrap="nowrap">
      <Badge color={statusColor(run.status)} variant="light">
        {run.status}
      </Badge>
      {run.adopted && <Badge variant="light">adopted</Badge>}
    </Group>
  );
}

export function WebappDetails({
  webapp,
  environment,
}: {
  webapp: Webapp;
  environment: EnvironmentRecord | null;
}) {
  const actions = useWebappActions();
  const [logSource, setLogSource] = useState<"filtered" | "raw">("filtered");
  const descriptor = webappDescriptor(webapp.kind);

  const runtimeQuery = useQuery({
    queryKey: ["webapp-runtime", webapp.name],
    queryFn: () => getWebappRuntime(webapp.name),
    refetchInterval: 3_000,
  });
  const preflightQuery = useQuery({
    queryKey: ["webapp-preflight", webapp.name],
    queryFn: () => getWebappPreflight(webapp.name),
    refetchInterval: 10_000,
  });
  const logsQuery = useQuery({
    queryKey: ["webapp-logs", webapp.name, logSource],
    queryFn: () => getWebappLogs(webapp.name, 300, logSource),
    refetchInterval: webapp.status === "running" ? 2_000 : 5_000,
  });
  const runsQuery = useQuery({
    queryKey: ["webapp-runs", webapp.name],
    queryFn: () => listWebappRuns(webapp.name),
    refetchInterval: 10_000,
  });

  const runtime = runtimeQuery.data?.data;
  const health = runtime?.health ?? null;
  const issues = preflightQuery.data?.data.issues ?? [];
  const runs = runsQuery.data?.data ?? [];

  return (
    <Stack gap="md">
      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap="xs">
              <Text fw={600}>{webapp.name}</Text>
              <Badge color={statusColor(webapp.status)}>{webapp.status}</Badge>
              <Badge variant="light" color={envStatusColor(webapp.envStatus)}>
                {webapp.envStatus === "installed" && webapp.envVersion
                  ? envVersionLabel(webapp.envVersion)
                  : `env ${webapp.envStatus}`}
              </Badge>
              <WebappConfigDriftBadge webapp={webapp} />
              {webapp.autostart && <Badge variant="light">autostart</Badge>}
            </Group>
            <Text size="xs" c="dimmed">
              {descriptor.displayName} · {webapp.http.host}:{webapp.http.port}
              {webapp.pid ? ` · pid ${webapp.pid}` : ""}
            </Text>
          </div>
          <Group gap="xs">
            <WebappActionButtons webapp={webapp} actions={actions} />
          </Group>
        </Group>
      </Paper>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Stack gap="md">
          <Paper withBorder p="md">
            <Title order={4} mb="xs">
              Health probe
            </Title>
            {health ? (
              <Stack gap={4}>
                <Group gap="xs">
                  <Badge color={health.ok ? "green" : "red"} variant="light">
                    {health.ok ? "ok" : "failing"}
                  </Badge>
                  <Text size="sm">
                    {health.status !== null
                      ? `HTTP ${health.status}`
                      : "no response"}
                    {` · ${health.latencyMs} ms`}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" className="text-wrap">
                  {health.url}
                </Text>
                {health.error && (
                  <Text size="xs" c="red">
                    {health.error}
                  </Text>
                )}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                {webapp.status === "running"
                  ? "Probing…"
                  : "Not probed — the app is not running."}
              </Text>
            )}
          </Paper>

          <Paper withBorder p="md">
            <Title order={4} mb="xs">
              Preflight
            </Title>
            {issues.length > 0 ? (
              <Stack gap={6}>
                {issues.map((issue) => (
                  <Group
                    key={`${issue.field}:${issue.message}`}
                    gap="xs"
                    wrap="nowrap"
                    align="flex-start"
                  >
                    <Badge
                      color={issue.level === "error" ? "red" : "orange"}
                      variant="light"
                      style={{ flexShrink: 0 }}
                    >
                      {issue.level}
                    </Badge>
                    <Text size="sm">{issue.message}</Text>
                  </Group>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                {preflightQuery.data
                  ? "No issues — the app is clear to start."
                  : "Checking…"}
              </Text>
            )}
          </Paper>

          <Paper withBorder p="md">
            <Title order={4} mb="xs">
              Environment
            </Title>
            {environment ? (
              <Stack gap={4}>
                <Group gap="xs">
                  <Text fw={600} size="sm">
                    {ENVIRONMENT_ENGINE_LABELS[environment.engine]}{" "}
                    {environment.version}
                  </Text>
                  <Badge color={envStatusColor(environment.status)}>
                    {environment.status}
                  </Badge>
                  <Badge
                    variant="light"
                    color={
                      environment.availability === "usable"
                        ? "green"
                        : environment.availability === "unavailable"
                          ? "red"
                          : "gray"
                    }
                  >
                    {environment.availability}
                  </Badge>
                </Group>
                {environment.availabilityReason && (
                  <Text size="xs" c="orange">
                    {environment.availabilityReason}
                  </Text>
                )}
                <Text size="xs" c="dimmed" className="text-wrap">
                  {environment.entrypoint}
                </Text>
                {environment.error && (
                  <Text size="xs" c="red">
                    {environment.error}
                  </Text>
                )}
              </Stack>
            ) : (
              <Text size="sm" c="red">
                Environment spec {webapp.envSpecId} was not found — reinstall it
                on the Install tab or repoint the app.
              </Text>
            )}
          </Paper>

          <Paper withBorder p="md">
            <Title order={4} mb="xs">
              Runtime
            </Title>
            {runtime ? (
              <Stack gap={4}>
                <DetailRow label="PID" value={runtime.pid?.toString() ?? "—"} />
                <DetailRow
                  label="Started"
                  value={
                    runtime.startedAt
                      ? formatLocalDateTime(runtime.startedAt)
                      : "—"
                  }
                />
                <DetailRow
                  label="Stopped"
                  value={
                    runtime.stoppedAt
                      ? formatLocalDateTime(runtime.stoppedAt)
                      : "—"
                  }
                />
                <DetailRow
                  label="Exit code"
                  value={runtime.exitCode?.toString() ?? "—"}
                />
                <DetailRow
                  label="Stop reason"
                  value={runtime.stopReason ?? "—"}
                />
                <DetailRow
                  label="Adopted"
                  value={
                    runtime.adopted
                      ? "yes — re-attached after a manager restart"
                      : "no"
                  }
                />
                <DetailRow label="Log file" value={runtime.logPath ?? "—"} />
                <DetailRow
                  label="Raw log file"
                  value={runtime.rawLogPath ?? "—"}
                />
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                Loading…
              </Text>
            )}
          </Paper>
        </Stack>

        <Paper withBorder p="md">
          <Group justify="space-between" mb="xs">
            <Title order={4}>Log</Title>
            <SegmentedControl
              size="xs"
              value={logSource}
              onChange={(value) => setLogSource(value as "filtered" | "raw")}
              data={[
                { value: "filtered", label: "Filtered" },
                { value: "raw", label: "Raw" },
              ]}
            />
          </Group>
          <Code
            block
            style={{ whiteSpace: "pre-wrap", maxHeight: 560, overflow: "auto" }}
          >
            {(logsQuery.data?.data.lines ?? ["No log yet."]).join("\n")}
          </Code>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="md">
        <Title order={4} mb="xs">
          Run history
        </Title>
        {runs.length > 0 ? (
          <Table.ScrollContainer minWidth={640}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Started</Table.Th>
                  <Table.Th>Stopped</Table.Th>
                  <Table.Th>Exit code</Table.Th>
                  <Table.Th>Stop reason</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runs.map((run) => (
                  <Table.Tr key={run.id}>
                    <Table.Td>{runStatusBadges(run)}</Table.Td>
                    <Table.Td>{formatLocalDateTime(run.startedAt)}</Table.Td>
                    <Table.Td>
                      {run.stoppedAt ? formatLocalDateTime(run.stoppedAt) : "—"}
                    </Table.Td>
                    <Table.Td>{run.exitCode ?? "—"}</Table.Td>
                    <Table.Td>{run.stopReason ?? "—"}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : (
          <Text size="sm" c="dimmed">
            No recorded runs yet.
          </Text>
        )}
      </Paper>
    </Stack>
  );
}
