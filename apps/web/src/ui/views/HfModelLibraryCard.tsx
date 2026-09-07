import { parseHfRepoInput, type ModelLibraryEntryStatus } from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  actOnModelLibraryEntry,
  createModelLibraryEntry,
  deleteModelLibraryEntry,
  listHfDownloads,
  listModelLibraryEntries,
} from "../../api/hf";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";
import { ModelLibraryDialog } from "./ModelLibraryDialog";

export function HfModelLibraryCard() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["hf-library"],
    queryFn: listModelLibraryEntries,
    refetchInterval: 15000,
  });
  const downloads = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });
  const [repo, setRepo] = useState("");
  const [revision, setRevision] = useState("main");
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const statuses = query.data?.data ?? [];
  const active = statuses.find((item) => item.entry.id === opened);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["hf-library"] });
    void client.invalidateQueries({ queryKey: ["hf-queue"] });
  };
  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => operation(),
    onSuccess: refresh,
    onError: notifyError("Model library"),
  });
  const run = (operation: () => Promise<unknown>) => mutation.mutate(operation);
  const add = () =>
    run(async () => {
      const parsed = parseHfRepoInput(repo);
      if (!parsed) throw new Error("Enter a Hugging Face repository ID or URL");
      await createModelLibraryEntry({
        repoId: parsed.repoId,
        revision: parsed.revision ?? revision,
        paths: [],
        destDir: null,
      });
      setRepo("");
    });
  const untracked = (downloads.data?.data ?? []).filter(
    (repo) =>
      !statuses.some(
        (status) =>
          status.matchedDir === repo.dir ||
          (status.entry.destDir === null &&
            status.entry.repoId === repo.repoId),
      ),
  );
  const downloadMissing = async (status: ModelLibraryEntryStatus) => {
    if (!status.missingPaths.length) return;
    await actOnModelLibraryEntry(status.entry.id, {
      action: "download",
      revision: status.entry.revision,
      paths: status.missingPaths,
    });
  };
  const bulk = async (action: "check" | "download") => {
    const results = await Promise.allSettled(
      statuses.map(async (status) => {
        if (action === "check")
          await actOnModelLibraryEntry(status.entry.id, {
            action: "check",
          });
        else await downloadMissing(status);
      }),
    );
    refresh();
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new Error(
        failures.map((result) => String(result.reason)).join("; "),
      );
  };
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>Model library</Title>
          <Group>
            <Button
              size="xs"
              variant="light"
              disabled={mutation.isPending || !statuses.length}
              onClick={() => run(() => bulk("check"))}
            >
              Check all repositories
            </Button>
            <Button
              size="xs"
              disabled={
                mutation.isPending ||
                !statuses.some((status) => status.missingPaths.length)
              }
              onClick={() => run(() => bulk("download"))}
            >
              Download missing
            </Button>
          </Group>
        </Group>
        <Text size="sm" c="dimmed">
          Save models for later, restore selected files, and follow repository
          changes even when no weights are installed.
        </Text>
        <Group align="end">
          <TextInput
            label="Repository"
            placeholder="owner/model or Hugging Face URL"
            value={repo}
            onChange={(event) => setRepo(event.currentTarget.value)}
            flex={1}
          />
          <TextInput
            label="Branch or revision"
            value={revision}
            onChange={(event) => setRevision(event.currentTarget.value)}
            w={180}
          />
          <Button disabled={!repo.trim() || mutation.isPending} onClick={add}>
            Add to library
          </Button>
        </Group>
        {mutation.isPending && <Text size="sm">Updating model library…</Text>}
        {query.error && <Alert color="red">{query.error.message}</Alert>}
        <TextInput
          placeholder="Filter saved repositories"
          aria-label="Filter saved repositories"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        {!query.isPending && !statuses.length && (
          <Text c="dimmed">Your model library is empty.</Text>
        )}
        {statuses
          .filter((status) =>
            status.entry.repoId.toLowerCase().includes(search.toLowerCase()),
          )
          .map((status) => (
            <Paper withBorder p="sm" key={status.entry.id}>
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text fw={600} className="text-wrap">
                    {status.entry.repoId}
                  </Text>
                  <Badge
                    color={
                      status.state === "satisfied"
                        ? "teal"
                        : status.state === "watching"
                          ? "gray"
                          : "yellow"
                    }
                  >
                    {status.state === "satisfied" ? "present" : status.state}
                  </Badge>
                </Group>
                <Group gap="xs">
                  <Text size="xs">Pinned:</Text>
                  <Code>{status.entry.revision.slice(0, 12)}</Code>
                  <Text size="xs">
                    {countLabel(status.entry.paths.length, "selected file")} ·
                    Watching {status.entry.watchRevision}
                  </Text>
                </Group>
                {(status.revisionMatch === false ||
                  status.driftPaths.length > 0) && (
                  <Text size="xs" c="orange">
                    Installed content or revision differs from the saved
                    version.
                  </Text>
                )}
                <Group gap="xs">
                  <Badge variant="outline">{status.check.status}</Badge>
                  {status.check.checkedAt && (
                    <Text size="xs" c="dimmed">
                      Checked{" "}
                      {new Date(status.check.checkedAt).toLocaleString()}
                    </Text>
                  )}
                </Group>
                {status.check.error && (
                  <Alert color="red">{status.check.error}</Alert>
                )}
                <Group>
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => setOpened(status.entry.id)}
                  >
                    Files and changes
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={mutation.isPending}
                    onClick={() =>
                      run(() =>
                        actOnModelLibraryEntry(status.entry.id, {
                          action: "check",
                        }),
                      )
                    }
                  >
                    Check updates
                  </Button>
                  <Button
                    size="xs"
                    disabled={mutation.isPending || !status.missingPaths.length}
                    onClick={() => run(() => downloadMissing(status))}
                  >
                    Download missing
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    disabled={mutation.isPending}
                    onClick={() =>
                      run(() => deleteModelLibraryEntry(status.entry.id))
                    }
                  >
                    Remove from library
                  </Button>
                </Group>
              </Stack>
            </Paper>
          ))}
        {untracked.map((repo) => (
          <Group key={repo.dir} justify="space-between">
            <Text size="sm" className="text-wrap">
              {repo.repoId} · downloaded
            </Text>
            <Button
              size="xs"
              disabled={mutation.isPending}
              onClick={() =>
                run(() =>
                  createModelLibraryEntry({
                    repoId: repo.repoId,
                    revision: repo.revision,
                    paths: repo.files.map((file) => file.path),
                    destDir: repo.dir,
                  }),
                )
              }
            >
              Add to library
            </Button>
          </Group>
        ))}
        {active && (
          <ModelLibraryDialog
            key={active.entry.id}
            status={active}
            onClose={() => setOpened(null)}
          />
        )}
      </Stack>
    </Paper>
  );
}
