import type { EngineHelpSourceSync } from "@arriero/core";
import {
  Alert,
  Badge,
  Code,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { AlertTriangle, CheckCircle2, FileClock, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import { getEngineHelpSourceDiff } from "../../api/client";
import { LazyDiff } from "../components/LazyDiff";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";

const kindLabels: Record<EngineHelpSourceSync["kind"], string> = {
  "help-block": "help block",
  "declaration-extract": "declaration extract",
};

const signalLabels: Record<EngineHelpSourceSync["signal"], string> = {
  "content-hash": "content hash",
  "commit-range": "commit range",
  none: "none",
};

function statusAppearance(sync: EngineHelpSourceSync) {
  if (sync.inSync === true) {
    return { color: "green", label: "in sync" };
  }
  if (sync.inSync === false) {
    return { color: "yellow", label: "drift" };
  }
  if (!sync.current.error && !sync.stored.exists) {
    return { color: "gray", label: "no snapshot" };
  }
  return { color: "red", label: "unavailable" };
}

function shortCommit(commit: string | null) {
  return commit ? commit.slice(0, 12) : "-";
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text c="dimmed" size="xs">
        {props.label}
      </Text>
      {props.children}
    </Stack>
  );
}

export function EngineHelpSourcePanel({
  sync,
}: {
  sync: EngineHelpSourceSync;
}) {
  const appearance = statusAppearance(sync);
  const pendingCommits = sync.pendingCommits ?? [];
  const snapshotMissing = !sync.stored.exists;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600}>{sync.displayName} argument help source</Text>
            <Text c="dimmed" size="sm">
              Stored argument snapshot vs the declarations in this checkout.
            </Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            <Badge color="gray" variant="outline">
              {kindLabels[sync.kind]}
            </Badge>
            <Badge color={appearance.color} variant="light">
              {appearance.label}
            </Badge>
          </Group>
        </Group>

        <Text c="dimmed" size="xs">
          Source:{" "}
          {sync.sourcePaths.map((path) => (
            <Code
              key={path}
              mr={4}
              style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
            >
              {path}
            </Code>
          ))}
        </Text>

        <Group gap="xl" wrap="wrap">
          <Field label="Snapshot">
            {snapshotMissing ? (
              <Text c="dimmed" size="sm">
                not written
              </Text>
            ) : (
              <Group gap={6} wrap="nowrap">
                <Code>{shortCommit(sync.stored.commit)}</Code>
                <Text c="dimmed" size="xs">
                  {formatLocalDateTime(sync.stored.updatedAt)}
                </Text>
              </Group>
            )}
          </Field>
          <Field label="Checkout">
            <Code>{shortCommit(sync.current.commit)}</Code>
          </Field>
          <Field label="Signal">
            <Text size="sm">{signalLabels[sync.signal]}</Text>
          </Field>
        </Group>

        {sync.current.error && (
          <Alert color="red" variant="light" icon={<XCircle size={16} />}>
            {sync.current.error}
          </Alert>
        )}

        {snapshotMissing && !sync.current.error && (
          <Alert color="blue" variant="light" icon={<FileClock size={16} />}>
            No reviewed snapshot has been written yet, so drift cannot be
            measured. Record the current declarations with{" "}
            <Code>
              pnpm --filter @arriero/api args:docs:source-sync -- --engine{" "}
              {sync.engineId} --write
            </Code>
            .
          </Alert>
        )}

        {sync.stored.error && !snapshotMissing && (
          <Alert color="red" variant="light" icon={<XCircle size={16} />}>
            {sync.stored.error}
          </Alert>
        )}

        {sync.inSync === true && (
          <Alert
            color="green"
            variant="light"
            icon={<CheckCircle2 size={16} />}
          >
            The stored snapshot matches the declarations in this checkout.
          </Alert>
        )}

        {sync.inSync === false && (
          <Alert
            color="yellow"
            variant="light"
            icon={<AlertTriangle size={16} />}
          >
            Argument declarations changed since the stored snapshot.
          </Alert>
        )}

        {sync.signal === "commit-range" && (
          <Alert
            color={pendingCommits.length > 0 ? "yellow" : "gray"}
            variant="light"
            icon={<AlertTriangle size={16} />}
            title={
              pendingCommits.length > 0
                ? `${countLabel(pendingCommits.length, "upstream commit")} touched the argument sources since the snapshot`
                : "No upstream commit touched the argument sources since the snapshot"
            }
          >
            {pendingCommits.length > 0 && (
              <ScrollArea.Autosize mah={160}>
                <Stack gap={2}>
                  {pendingCommits.map((commit) => (
                    <Code key={commit}>{commit}</Code>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            )}
          </Alert>
        )}

        {!sync.current.error && (
          <LazyDiff
            queryKey={["engine-help-source-diff", sync.engineId]}
            queryFn={() => getEngineHelpSourceDiff(sync.engineId)}
          />
        )}
      </Stack>
    </Paper>
  );
}
