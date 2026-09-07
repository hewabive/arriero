import {
  isHfCommitSha,
  type ModelLibraryAction,
  type ModelLibraryEntryStatus,
  type ModelLibraryFile,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { actOnModelLibraryEntry, getModelLibrarySnapshot } from "../../api/hf";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";
import { formatBytes } from "../utils/models";
import { formatLocalDateTime } from "../utils/time";
import { modelLibraryFileRows } from "../utils/model-library-files";

function versionSize(
  files: ModelLibraryFile[],
  complete: boolean,
  known: boolean,
): string {
  if (!known) return "Not checked";
  if (!files.length) return "Absent";
  return `${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}${complete ? "" : " · incomplete"}`;
}

export function ModelLibraryDialog({
  status,
  onClose,
}: {
  status: ModelLibraryEntryStatus;
  onClose: () => void;
}) {
  const entry = status.entry;
  const client = useQueryClient();
  const [version, setVersion] = useState("pinned");
  const [chosen, setChosen] = useState(entry.paths);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const pinned = useQuery({
    queryKey: ["hf-library-snapshot", entry.id, entry.revision],
    queryFn: () => getModelLibrarySnapshot(entry.id),
  });
  const latest = status.check.snapshot;
  const snapshot = version === "latest" ? latest : pinned.data?.data;
  const rows = useMemo(
    () =>
      modelLibraryFileRows(
        pinned.data?.data ?? null,
        latest,
        status.check.changes,
        entry.paths,
      ),
    [pinned.data, latest, status.check.changes, entry.paths],
  );
  const available = new Set(snapshot?.files.map((file) => file.path));
  const paths = chosen.filter((path) => available.has(path));
  const missingChoice = chosen.filter((path) => !available.has(path));
  const filtered = rows.filter(
    (row) =>
      row.paths.some((path) =>
        path.toLowerCase().includes(search.toLowerCase()),
      ) &&
      (filter === "all" ||
        (filter === "saved" && row.saved) ||
        (filter === "changes" && row.kinds.length > 0)),
  );
  const dirty =
    paths.length !== entry.paths.length ||
    paths.some((path) => !entry.paths.includes(path)) ||
    snapshot?.revision !== entry.revision;
  const mutation = useMutation({
    mutationFn: (action: ModelLibraryAction) =>
      actOnModelLibraryEntry(entry.id, action),
    onSuccess: (_result, action) => {
      void client.invalidateQueries({ queryKey: ["hf-library"] });
      void client.invalidateQueries({ queryKey: ["hf-queue"] });
      if (action.action === "select" || action.action === "pin") {
        void client.invalidateQueries({
          queryKey: ["hf-library-snapshot", entry.id],
        });
        setVersion("pinned");
      }
      notifications.show({
        message:
          action.action === "download"
            ? "Chosen files added to the download queue"
            : action.action === "acknowledge"
              ? "Changes marked as reviewed. Installation version preserved."
              : action.action === "check"
                ? "Repository check completed"
                : "Pinned version and saved selection updated",
      });
    },
    onError: notifyError("Model library"),
  });
  const downloadingUnsaved = paths.some((path) => !entry.paths.includes(path));
  return (
    <Modal opened onClose={onClose} title={entry.repoId} size="xl">
      <Stack gap="sm">
        <Group justify="space-between" align="start">
          <Stack gap={3}>
            <Group gap="xs">
              <Text size="xs">Pinned</Text>
              <Code>{entry.revision.slice(0, 12)}</Code>
              <Text size="xs">Latest checked</Text>
              <Code>{latest?.revision.slice(0, 12) ?? "—"}</Code>
            </Group>
            <Text size="xs" c="dimmed">
              Watching {entry.watchRevision}
              {status.check.checkedAt
                ? ` · Checked ${formatLocalDateTime(status.check.checkedAt)}`
                : " · Not checked yet"}
            </Text>
          </Stack>
          <Button
            size="xs"
            variant="default"
            loading={
              mutation.isPending && mutation.variables.action === "check"
            }
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ action: "check" })}
          >
            Check updates
          </Button>
        </Group>
        {status.check.error && <Alert color="red">{status.check.error}</Alert>}
        {latest && (
          <Paper withBorder p="sm">
            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">
                  {status.check.changes.length
                    ? `${countLabel(status.check.changes.length, "file change")} since your last review`
                    : status.check.status === "changed"
                      ? "Repository revision changed; file contents are unchanged."
                      : "No file changes since your last review."}
                </Text>
                <Text size="xs" c="dimmed">
                  Reviewing changes preserves the pinned installation version.
                </Text>
              </Stack>
              <Button
                size="xs"
                variant="subtle"
                disabled={
                  mutation.isPending ||
                  (status.check.status === "current" &&
                    entry.snapshot?.revision === latest.revision)
                }
                onClick={() =>
                  mutation.mutate({
                    action: "acknowledge",
                    revision: latest.revision,
                  })
                }
              >
                Mark reviewed
              </Button>
            </Group>
          </Paper>
        )}
        {!isHfCommitSha(entry.revision) && (
          <Alert color="blue">
            Save the selection to fix a revision before downloading.
          </Alert>
        )}
        {pinned.error && (
          <Alert color="red">
            Pinned files could not be loaded: {pinned.error.message}
          </Alert>
        )}
        <Group align="end">
          <TextInput
            aria-label="Search library files"
            placeholder="Search files"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            flex={1}
            miw={160}
          />
          <Select
            aria-label="Filter library files"
            value={filter}
            onChange={(value) => setFilter(value ?? "all")}
            data={[
              { value: "all", label: "All files" },
              { value: "saved", label: "Saved selection" },
              { value: "changes", label: "Changes since review" },
            ]}
            w={190}
          />
        </Group>
        <Group justify="space-between">
          <Text size="xs">
            {countLabel(paths.length, "selected file")} ·{" "}
            {formatBytes(
              snapshot?.files
                .filter((file) => paths.includes(file.path))
                .reduce((sum, file) => sum + file.size, 0) ?? 0,
            )}
          </Text>
          <Group gap={0}>
            <Button
              size="xs"
              variant="subtle"
              disabled={mutation.isPending}
              onClick={() => setChosen([...entry.paths])}
            >
              Reset selection
            </Button>
            <Button
              size="xs"
              variant="subtle"
              disabled={mutation.isPending || !chosen.length}
              onClick={() => setChosen([])}
            >
              Clear
            </Button>
          </Group>
        </Group>
        {pinned.isPending && (
          <Text size="sm" c="dimmed">
            Loading pinned files…
          </Text>
        )}
        <ScrollArea.Autosize mah={390}>
          <Stack gap="xs">
            {filtered.slice(0, 200).map((row) => {
              const complete =
                version === "latest" ? row.latestComplete : row.pinnedComplete;
              return (
                <Paper withBorder p="xs" key={row.paths[0]}>
                  <Stack gap={4}>
                    <Checkbox
                      checked={row.paths.every((path) => chosen.includes(path))}
                      indeterminate={
                        row.paths.some((path) => chosen.includes(path)) &&
                        !row.paths.every((path) => chosen.includes(path))
                      }
                      disabled={
                        mutation.isPending ||
                        (!complete &&
                          !row.paths.some((path) => chosen.includes(path)))
                      }
                      label={`${row.paths[0]}${row.paths.length > 1 ? ` (${countLabel(row.paths.length, "shard")})` : ""}`}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        const members = new Set(row.paths);
                        setChosen((previous) =>
                          checked
                            ? [...new Set([...previous, ...members])]
                            : previous.filter((path) => !members.has(path)),
                        );
                      }}
                    />
                    <Group gap="xs" ml={28}>
                      <Text size="xs" c="dimmed">
                        Pinned:{" "}
                        {versionSize(
                          row.pinnedFiles,
                          row.pinnedComplete,
                          !!pinned.data,
                        )}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Latest:{" "}
                        {versionSize(
                          row.latestFiles,
                          row.latestComplete,
                          !!latest,
                        )}
                      </Text>
                      {row.contentChanged && (
                        <Badge size="xs" variant="outline" color="orange">
                          Differs from pin
                        </Badge>
                      )}
                      {row.kinds.map((kind) => (
                        <Badge
                          size="xs"
                          key={kind}
                          color={
                            kind === "added"
                              ? "teal"
                              : kind === "deleted"
                                ? "red"
                                : "yellow"
                          }
                        >
                          {kind} since review
                        </Badge>
                      ))}
                    </Group>
                  </Stack>
                </Paper>
              );
            })}
            {!filtered.length && !pinned.isPending && (
              <Text size="sm" c="dimmed">
                No files match these filters.
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
        {filtered.length > 200 && (
          <Text size="xs" c="dimmed">
            Showing the first 200 groups. Search to find other files.
          </Text>
        )}
        <Paper withBorder p="sm">
          <Stack gap="xs">
            <Select
              label="Version for saving and downloading"
              value={version}
              onChange={(value) => setVersion(value ?? "pinned")}
              disabled={mutation.isPending}
              data={[
                {
                  value: "pinned",
                  label: `Pinned · ${entry.revision.slice(0, 12)}`,
                },
                {
                  value: "latest",
                  label: `Latest checked · ${latest?.revision.slice(0, 12) ?? "not available"}`,
                  disabled: !latest || latest.revision === entry.revision,
                },
              ]}
            />
            <Text size="xs" c="dimmed">
              Save changes the shared selection. Download uses only the checked
              files on this host. Shards stay together; safetensors include
              their folder's model support files.
            </Text>
            {snapshot && missingChoice.length > 0 && (
              <Alert color="yellow">
                {countLabel(missingChoice.length, "selected file")} absent from
                this version. Saving will remove{" "}
                {missingChoice.length === 1 ? "it" : "them"} from the saved
                selection: {missingChoice.slice(0, 3).join(", ")}
                {missingChoice.length > 3 ? ", …" : ""}
              </Alert>
            )}
            {(version === "latest" || downloadingUnsaved) && (
              <Text size="xs" c="blue">
                Save this version and selection before downloading new files.
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="light"
                disabled={!snapshot || mutation.isPending || !dirty}
                loading={
                  mutation.isPending &&
                  (mutation.variables.action === "pin" ||
                    mutation.variables.action === "select")
                }
                onClick={() =>
                  mutation.mutate({
                    action: version === "latest" ? "pin" : "select",
                    revision: snapshot!.revision,
                    paths,
                  })
                }
              >
                {version === "latest"
                  ? "Pin latest and save selection"
                  : "Save selection"}
              </Button>
              <Button
                disabled={
                  version !== "pinned" ||
                  !isHfCommitSha(entry.revision) ||
                  !snapshot ||
                  !paths.length ||
                  downloadingUnsaved ||
                  mutation.isPending
                }
                loading={
                  mutation.isPending && mutation.variables.action === "download"
                }
                onClick={() =>
                  mutation.mutate({
                    action: "download",
                    revision: entry.revision,
                    paths,
                  })
                }
              >
                Download selected
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Stack>
    </Modal>
  );
}
