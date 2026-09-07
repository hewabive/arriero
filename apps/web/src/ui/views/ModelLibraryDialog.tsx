import {
  groupGgufFiles,
  isHfCommitSha,
  type ModelLibraryAction,
  type ModelLibraryEntryStatus,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { actOnModelLibraryEntry, getModelLibrarySnapshot } from "../../api/hf";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";
import { formatBytes } from "../utils/models";

export function ModelLibraryDialog({
  status,
  onClose,
}: {
  status: ModelLibraryEntryStatus;
  onClose: () => void;
}) {
  const entry = status.entry;
  const client = useQueryClient();
  const [mode, setMode] = useState("pinned");
  const [chosen, setChosen] = useState(entry.paths);
  const [search, setSearch] = useState("");
  const pinned = useQuery({
    queryKey: ["hf-library-snapshot", entry.id, entry.revision],
    queryFn: () => getModelLibrarySnapshot(entry.id),
  });
  const snapshot =
    mode === "pinned" ? pinned.data?.data : status.check.snapshot;
  const available = new Set(snapshot?.files.map((file) => file.path));
  const paths = chosen.filter((path) => available.has(path));
  const groups = groupGgufFiles(snapshot?.files ?? [], (file) => file.path);
  const filtered = groups.filter((group) =>
    group.files.some((file) =>
      file.path.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  const mutation = useMutation({
    mutationFn: (action: ModelLibraryAction) =>
      actOnModelLibraryEntry(entry.id, action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["hf-library"] });
      void client.invalidateQueries({ queryKey: ["hf-library-snapshot"] });
      void client.invalidateQueries({ queryKey: ["hf-queue"] });
      onClose();
    },
    onError: notifyError("Model library"),
  });
  return (
    <Modal opened onClose={onClose} title={entry.repoId} size="xl">
      <Stack gap="sm">
        <Text size="sm">
          Choose files to keep in the shared library, or download a subset on
          this host. GGUF shards stay together; safetensors selections include
          the weights and support files in their directory.
        </Text>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          data={[
            { value: "pinned", label: "Pinned version" },
            {
              value: "latest",
              label: "Latest checked version",
              disabled: !status.check.snapshot,
            },
          ]}
        />
        {snapshot && (
          <Group gap="xs">
            <Text size="xs">Revision:</Text>
            <Code>{snapshot.revision.slice(0, 12)}</Code>
            <Text size="xs">
              {countLabel(snapshot.files.length, "repository file")}
            </Text>
          </Group>
        )}
        {mode === "latest" && (
          <Stack gap="xs">
            <Text size="sm">
              Repository changes since the accepted snapshot
            </Text>
            <ScrollArea.Autosize mah={180}>
              {status.check.changes.map((change) => (
                <Group key={change.path} gap="xs" wrap="nowrap">
                  <Badge
                    color={
                      change.kind === "deleted"
                        ? "red"
                        : change.kind === "added"
                          ? "teal"
                          : "yellow"
                    }
                  >
                    {change.kind}
                  </Badge>
                  <Text size="xs" className="text-wrap">
                    {change.path}
                  </Text>
                </Group>
              ))}
              {!status.check.changes.length && (
                <Text size="sm" c="dimmed">
                  No file content changes.
                </Text>
              )}
            </ScrollArea.Autosize>
            <Button
              size="xs"
              variant="light"
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  action: "acknowledge",
                  revision: status.check.snapshot!.revision,
                })
              }
            >
              Mark changes reviewed
            </Button>
            <Text size="xs" c="dimmed">
              Reviewing changes keeps the pinned installation version.
            </Text>
          </Stack>
        )}
        {!isHfCommitSha(entry.revision) && (
          <Alert color="blue">
            Save the selection to pin this legacy entry before downloading.
          </Alert>
        )}
        {pinned.error && mode === "pinned" && (
          <Alert color="red">{pinned.error.message}</Alert>
        )}
        {chosen.some((path) => !available.has(path)) && snapshot && (
          <Alert color="yellow">
            Some saved files are absent from this revision. Saving this
            selection removes them from the saved set.
          </Alert>
        )}
        <TextInput
          placeholder="Filter files"
          aria-label="Filter library files"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <Group>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => setChosen([...entry.paths])}
          >
            Saved selection
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setChosen([])}>
            Clear selection
          </Button>
          <Text size="xs">{countLabel(paths.length, "selected file")}</Text>
        </Group>
        <ScrollArea.Autosize mah={380}>
          <Stack gap="xs">
            {filtered.slice(0, 200).map((group) => {
              const first = group.files[0]!;
              return (
                <Checkbox
                  key={first.path}
                  disabled={!group.complete || mutation.isPending}
                  label={`${first.path}${group.files.length > 1 ? ` (${countLabel(group.files.length, "shard")})` : ""}`}
                  description={`${formatBytes(group.files.reduce((sum, file) => sum + file.size, 0))}${group.complete ? "" : " · incomplete group"}`}
                  checked={group.files.every((file) =>
                    chosen.includes(file.path),
                  )}
                  indeterminate={
                    group.files.some((file) => chosen.includes(file.path)) &&
                    !group.files.every((file) => chosen.includes(file.path))
                  }
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    const members = new Set(
                      group.files.map((file) => file.path),
                    );
                    setChosen((previous) =>
                      checked
                        ? [...new Set([...previous, ...members])]
                        : previous.filter((path) => !members.has(path)),
                    );
                  }}
                />
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
        {filtered.length > 200 && (
          <Text size="xs" c="dimmed">
            Showing the first 200 groups. Filter to find other files.
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Presence is based on local download metadata. Use Verify files on an
          installed repository to check its actual contents.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="light"
            disabled={!snapshot || mutation.isPending}
            onClick={() =>
              mutation.mutate({
                action: mode === "latest" ? "pin" : "select",
                revision: snapshot!.revision,
                paths,
              })
            }
          >
            {mode === "latest"
              ? "Pin this version and selection"
              : "Save selection"}
          </Button>
          <Button
            disabled={
              mode !== "pinned" ||
              !isHfCommitSha(entry.revision) ||
              !snapshot ||
              !paths.length ||
              paths.some((path) => !entry.paths.includes(path)) ||
              mutation.isPending
            }
            onClick={() =>
              mutation.mutate({
                action: "download",
                revision: entry.revision,
                paths,
              })
            }
          >
            Download chosen files
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
