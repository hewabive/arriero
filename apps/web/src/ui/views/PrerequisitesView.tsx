import type {
  PrerequisiteCheck,
  PrerequisiteGroup,
  PrerequisiteHost,
  PrerequisiteStatus,
  PrerequisiteSummary,
} from "@arriero/core";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getPrerequisiteReport } from "../../api/client";
import { formatLocalDateTime } from "../utils/time";
import {
  CommandBlock,
  InstallRunPanel,
  usePrerequisiteInstall,
  type PrerequisiteInstallControls,
} from "./prerequisites/InstallControls";

function statusColor(status: PrerequisiteStatus): string {
  if (status === "ok") return "green";
  if (status === "out-of-path") return "yellow";
  if (status === "unknown") return "gray";
  return "red";
}

function statusLabel(status: PrerequisiteStatus): string {
  if (status === "ok") return "present";
  if (status === "out-of-path") return "not on PATH";
  if (status === "unknown") return "not verified";
  return "missing";
}

function SummaryBadges(props: { summary: PrerequisiteSummary }) {
  const { summary } = props;
  return (
    <Group gap="xs">
      {summary.missingRequired > 0 && (
        <Badge color="red">{summary.missingRequired} required missing</Badge>
      )}
      {summary.missingRecommended > 0 && (
        <Badge color="orange">
          {summary.missingRecommended} recommended missing
        </Badge>
      )}
      {summary.outOfPath > 0 && (
        <Badge color="yellow">{summary.outOfPath} not on PATH</Badge>
      )}
      {summary.unknown > 0 && (
        <Badge color="gray">{summary.unknown} not verified</Badge>
      )}
      <Badge color="green" variant="light">
        {summary.ok} present
      </Badge>
    </Group>
  );
}

function HostFacts(props: { host: PrerequisiteHost }) {
  const { host } = props;
  return (
    <Accordion variant="contained">
      <Accordion.Item value="host">
        <Accordion.Control>
          <Text size="sm">
            Manager process environment ({host.path.length} PATH entries)
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              Detection uses the PATH of the manager process, which is what
              spawned builds and instances actually see. A systemd --user unit
              has a much shorter PATH than an interactive shell.
            </Text>
            <Code block style={{ whiteSpace: "pre-wrap" }}>
              {host.path.join("\n")}
            </Code>
            {host.autoRepairedPath.length > 0 && (
              <>
                <Text size="xs" c="dimmed">
                  Appended automatically at startup because these well-known
                  tool directories exist but were absent from PATH:
                </Text>
                <Code block style={{ whiteSpace: "pre-wrap" }}>
                  {host.autoRepairedPath.join("\n")}
                </Code>
              </>
            )}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function CheckRow(props: {
  check: PrerequisiteCheck;
  install: PrerequisiteInstallControls;
}) {
  const { check, install } = props;
  const resolved = check.status === "ok" || check.status === "out-of-path";

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="xs" wrap="wrap">
            <Badge color={statusColor(check.status)}>
              {statusLabel(check.status)}
            </Badge>
            <Text fw={600}>{check.title}</Text>
            {check.severity === "required" ? (
              <Badge variant="outline" color="red" size="sm">
                required
              </Badge>
            ) : (
              <Badge variant="outline" color="gray" size="sm">
                recommended
              </Badge>
            )}
          </Group>
          <Group gap={4} wrap="wrap">
            {check.blocks.map((item) => (
              <Badge key={item} variant="light" color="blue" size="sm">
                {item}
              </Badge>
            ))}
          </Group>
        </Group>

        {resolved && check.detail && (
          <Text size="xs" ff="monospace" c="dimmed">
            {check.detail}
            {check.version ? ` — ${check.version}` : ""}
          </Text>
        )}

        {!resolved && <Text size="sm">{check.impact}</Text>}

        {check.status === "out-of-path" && (
          <Text size="sm">
            Found on disk but not on the manager PATH; restart the manager to
            pick it up, or add its directory to the service environment.
          </Text>
        )}

        {check.status === "unknown" && check.detail && (
          <Text size="sm" c="dimmed">
            {check.detail}
          </Text>
        )}

        {!resolved && check.remediation.installCommand && (
          <CommandBlock
            command={check.remediation.installCommand}
            {...(check.remediation.rebootRequired
              ? {}
              : { install, request: { checkId: check.id } })}
          />
        )}

        {!resolved && check.remediation.rebootRequired && (
          <Alert color="yellow" title="Server reboot required">
            Installation completed successfully during this boot. Reboot the
            server manually to load the newly installed components; the install
            action stays unavailable until the boot changes.
          </Alert>
        )}

        {!resolved &&
          check.remediation.commands.map((command) => (
            <CommandBlock key={command} command={command} />
          ))}

        {!resolved && check.remediation.note && (
          <Text size="xs" c="dimmed">
            {check.remediation.note}
          </Text>
        )}

        {!resolved && check.remediation.docPath && (
          <Text size="xs" c="dimmed">
            Details: <Code>{check.remediation.docPath}</Code>
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function GroupCard(props: {
  group: PrerequisiteGroup;
  install: PrerequisiteInstallControls;
}) {
  const { group, install } = props;
  const blocking = group.checks.filter(
    (check) => check.status === "missing" && check.severity === "required",
  ).length;

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Title order={5}>{group.title}</Title>
            <Text size="xs" c="dimmed">
              {group.description}
            </Text>
          </Stack>
          {blocking > 0 && <Badge color="red">{blocking} blocking</Badge>}
        </Group>
        {group.checks.map((check) => (
          <CheckRow key={check.id} check={check} install={install} />
        ))}
      </Stack>
    </Paper>
  );
}

export function PrerequisitesView() {
  const reportQuery = useQuery({
    queryKey: ["prerequisites"],
    queryFn: getPrerequisiteReport,
  });
  const report = reportQuery.data?.data;
  const install = usePrerequisiteInstall(report?.installRunner);
  const [dismissedInstallRunId, setDismissedInstallRunId] = useState<
    string | null
  >(null);
  const installRun = install.run;
  const requiredSetupIncomplete = (report?.summary.unresolvedRequired ?? 0) > 0;

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="md">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <Text fw={600}>{report?.host.osName ?? "Unknown host"}</Text>
                <Badge variant="light">
                  {report?.host.packageManager ?? "unknown"}
                </Badge>
                <Badge variant="light" color="grape">
                  {report?.host.runMode ?? "unknown"} mode
                </Badge>
              </Group>
              {report && (
                <Text size="xs" c="dimmed">
                  Checked {formatLocalDateTime(report.checkedAt)}
                </Text>
              )}
            </Stack>
            <Group gap="xs">
              {reportQuery.isFetching && <Loader size="xs" />}
              <Button
                variant="default"
                onClick={() => void reportQuery.refetch()}
                loading={reportQuery.isFetching}
              >
                Re-check
              </Button>
            </Group>
          </Group>

          {report && <SummaryBadges summary={report.summary} />}

          {reportQuery.isError && (
            <Alert color="red" title="Could not read prerequisites">
              {(reportQuery.error as Error).message}
            </Alert>
          )}

          {report?.install.requiredCommand && (
            <Alert color="red" title="Required host setup is incomplete">
              <Stack gap="xs">
                <Text size="sm">
                  {report.installRunner.available
                    ? "Run the combined command as an administrator — or run it from here: the manager can elevate without a password. Resolve any remaining per-item actions below, then press Re-check."
                    : "Run the combined command as an administrator, resolve any remaining per-item actions below, then press Re-check."}
                </Text>
                <CommandBlock
                  command={report.install.requiredCommand}
                  install={install}
                  request={{ scope: "required" }}
                />
                {report.install.allCommand !==
                  report.install.requiredCommand && (
                  <>
                    <Text size="xs" c="dimmed">
                      Including the recommended tooling:
                    </Text>
                    <CommandBlock
                      command={report.install.allCommand!}
                      install={install}
                      request={{ scope: "all" }}
                    />
                  </>
                )}
              </Stack>
            </Alert>
          )}

          {report &&
            !report.install.requiredCommand &&
            requiredSetupIncomplete && (
              <Alert color="red" title="Required host setup is incomplete">
                Resolve the required per-item actions below, then press
                Re-check.
              </Alert>
            )}

          {report && !requiredSetupIncomplete && (
            <Alert color="green" title="No blocking gaps">
              Every required prerequisite for the features configured on this
              node is present.
            </Alert>
          )}

          {report &&
            !report.install.requiredCommand &&
            report.install.allCommand && (
              <Alert
                color="yellow"
                title={
                  requiredSetupIncomplete
                    ? "Recommended tooling is also missing"
                    : "Recommended tooling is missing"
                }
              >
                <Stack gap="xs">
                  <Text size="sm">
                    {requiredSetupIncomplete
                      ? "The remaining required gaps need separate actions. The recommended tooling below can be installed independently."
                      : "Nothing is blocked, but the recommended tooling below is absent."}
                    {report.installRunner.available &&
                      " The manager can install it from here — it elevates without a password."}
                  </Text>
                  <CommandBlock
                    command={report.install.allCommand}
                    install={install}
                    request={{ scope: "all" }}
                  />
                </Stack>
              </Alert>
            )}

          {install.startError && (
            <Alert color="red" title="Could not start the installation">
              {install.startError.message}
            </Alert>
          )}

          {installRun && installRun.id !== dismissedInstallRunId && (
            <InstallRunPanel
              key={installRun.id}
              run={installRun}
              onDismiss={() => setDismissedInstallRunId(installRun.id)}
            />
          )}

          {report && <HostFacts host={report.host} />}
        </Stack>
      </Paper>

      {report?.groups.map((group) => (
        <GroupCard key={group.id} group={group} install={install} />
      ))}
    </Stack>
  );
}
