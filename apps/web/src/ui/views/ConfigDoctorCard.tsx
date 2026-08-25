import type { ConfigDoctorFinding, ConfigDoctorReport } from "@arriero/core";
import {
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Stethoscope } from "lucide-react";

import { getConfigDoctorReport } from "../../api/client";
import { formatLocalDateTime } from "../utils/time";

const CHECK_ROUTES: Record<string, string> = {
  "instance-binaries": "/instances",
  environments: "/environments",
  "model-requirements": "/downloads",
  "instance-model-paths": "/downloads",
  "resource-pools": "/proxy/resources",
  "proxy-credentials": "/proxy/endpoints",
  "node-tokens": "/nodes",
  "hf-token": "/downloads",
  presets: "/presets",
};

function severityColor(severity: ConfigDoctorFinding["severity"]): string {
  switch (severity) {
    case "error":
      return "red";
    case "warning":
      return "yellow";
    default:
      return "gray";
  }
}

export function ConfigDoctorCard() {
  const doctorQuery = useQuery({
    queryKey: ["config-doctor"],
    queryFn: getConfigDoctorReport,
    staleTime: 30_000,
  });
  const report: ConfigDoctorReport | undefined = doctorQuery.data?.data;
  if (!report) {
    return null;
  }
  const withFindings = report.checks.filter(
    (check) => check.findings.length > 0,
  );
  const skipped = report.checks.filter((check) => check.status === "skipped");
  const clean = withFindings.length === 0 && skipped.length === 0;

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Stethoscope size={18} />
            <Title order={4}>Host readiness</Title>
            {report.summary.errors > 0 && (
              <Badge color="red" variant="light">
                {report.summary.errors} errors
              </Badge>
            )}
            {report.summary.warnings > 0 && (
              <Badge color="yellow" variant="light">
                {report.summary.warnings} warnings
              </Badge>
            )}
            {clean && (
              <Badge color="teal" variant="light">
                everything satisfied
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            checked {formatLocalDateTime(report.checkedAt)}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          What this host cannot satisfy from the tracked configuration. Advisory
          only — git operations are never blocked.
        </Text>

        {withFindings.map((check) => (
          <Stack key={check.id} gap={4}>
            <Group gap="xs" justify="space-between" wrap="wrap">
              <Text fw={600} size="sm">
                {check.title}
              </Text>
              {CHECK_ROUTES[check.id] && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  component="a"
                  href={`#${CHECK_ROUTES[check.id]}`}
                >
                  open
                </Button>
              )}
            </Group>
            {check.findings.map((finding, index) => (
              <Group
                key={`${finding.checkId}:${index}`}
                gap="xs"
                wrap="nowrap"
                align="flex-start"
              >
                <Badge
                  color={severityColor(finding.severity)}
                  variant="light"
                  size="sm"
                  miw={70}
                >
                  {finding.severity}
                </Badge>
                <Stack gap={0}>
                  <Tooltip
                    label={finding.remediation ?? ""}
                    disabled={!finding.remediation}
                    multiline
                    maw={360}
                  >
                    <Text size="sm">{finding.summary}</Text>
                  </Tooltip>
                  {finding.detail && (
                    <Code style={{ overflowWrap: "anywhere" }}>
                      {finding.detail}
                    </Code>
                  )}
                </Stack>
              </Group>
            ))}
          </Stack>
        ))}

        {skipped.length > 0 && (
          <Text size="xs" c="dimmed">
            skipped: {skipped.map((check) => check.title).join(", ")}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
