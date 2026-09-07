import {
  isHfCommitSha,
  parseHfRepoInput,
  type HfDownloadedRepo,
  type ModelLibraryEntryStatus,
} from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Menu,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, RefreshCw } from "lucide-react";
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
import { hfVariantChipLabel } from "../utils/hf";
import { formatBytes } from "../utils/models";
import { formatLocalDateTime } from "../utils/time";
import { ModelLibraryDialog } from "./ModelLibraryDialog";
import { HfRepoDetailModal } from "./HfRepoDetailModal";
import { HfRepoDeleteModal } from "./HfRepoDeleteModal";
import { useHfJobsSync, useHfQueueQuery } from "./use-hf-queue";

function diskBytes(repo: HfDownloadedRepo): number {
  return repo.files.reduce(
    (sum, file) => sum + (file.present ? file.size : file.partialBytes),
    0,
  );
}

export function ModelLibraryView() {
  useHfJobsSync();
  const client = useQueryClient();
  const library = useQuery({
    queryKey: ["hf-library"],
    queryFn: listModelLibraryEntries,
    refetchInterval: 15000,
  });
  const downloads = useQuery({
    queryKey: ["hf-downloads"],
    queryFn: listHfDownloads,
  });
  const queue = useHfQueueQuery().data?.data;
  const [repoInput, setRepoInput] = useState("");
  const [revision, setRevision] = useState("main");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [opened, setOpened] = useState<string | null>(null);
  const [detailDir, setDetailDir] = useState<string | null>(null);
  const [deleteDir, setDeleteDir] = useState<string | null>(null);
  const statuses = library.data?.data ?? [];
  const repos = downloads.data?.data ?? [];
  const active = statuses.find((status) => status.entry.id === opened);
  const activeJobs = queue
    ? [
        ...(queue.active ? [queue.active] : []),
        ...queue.queued,
        ...queue.paused,
      ]
    : [];
  const jobFor = (status: ModelLibraryEntryStatus) =>
    activeJobs.find(
      (job) =>
        job.repoId === status.entry.repoId &&
        (!status.entry.destDir || job.destDir === status.entry.destDir),
    );
  const rows = [
    ...statuses.map((status) => ({
      status,
      repo: repos.find((repo) => repo.dir === status.matchedDir) ?? null,
    })),
    ...repos
      .filter(
        (repo) => !statuses.some((status) => status.matchedDir === repo.dir),
      )
      .map((repo) => ({ status: null, repo })),
  ];
  const filtered = rows.filter(
    ({ status, repo }) =>
      (status?.entry.repoId ?? repo!.repoId)
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "saved" && status) ||
        (filter === "installed" && repo && diskBytes(repo) > 0) ||
        (filter === "missing" && status?.missingPaths.length) ||
        (filter === "changes" && status?.check.status === "changed")),
  );
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["hf-library"] });
    void client.invalidateQueries({ queryKey: ["hf-queue"] });
  };
  const mutation = useMutation({
    mutationFn: async (input: { label: string; run: () => Promise<unknown> }) =>
      input.run(),
    onSuccess: refresh,
    onError: notifyError("Model library"),
  });
  const run = (label: string, operation: () => Promise<unknown>) =>
    mutation.mutate({ label, run: operation });
  const downloadMissing = async (status: ModelLibraryEntryStatus) => {
    if (
      !status.missingPaths.length ||
      jobFor(status) ||
      !isHfCommitSha(status.entry.revision)
    )
      return;
    await actOnModelLibraryEntry(status.entry.id, {
      action: "download",
      revision: status.entry.revision,
      paths: status.missingPaths,
    });
    notifications.show({
      message: `${status.entry.repoId}: missing files added to the download queue`,
    });
  };
  const bulk = async (action: "check" | "download") => {
    const failures: string[] = [];
    for (let index = 0; index < statuses.length; index += 4) {
      const results = await Promise.allSettled(
        statuses
          .slice(index, index + 4)
          .map((status) =>
            action === "check"
              ? actOnModelLibraryEntry(status.entry.id, { action: "check" })
              : downloadMissing(status),
          ),
      );
      results.forEach((result) => {
        if (result.status === "rejected") failures.push(String(result.reason));
      });
      refresh();
    }
    if (failures.length) throw new Error(failures.join("; "));
  };
  const deleteRepo = repos.find((repo) => repo.dir === deleteDir);
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group gap="xs">
          <Badge variant="light">
            {countLabel(
              statuses.length,
              "saved repository",
              "saved repositories",
            )}
          </Badge>
          <Text size="sm" c="dimmed">
            {formatBytes(repos.reduce((sum, repo) => sum + diskBytes(repo), 0))}{" "}
            on disk
          </Text>
        </Group>
        <Group gap="xs">
          <Button component="a" href="#/downloads" variant="default">
            Download queue{activeJobs.length ? ` (${activeJobs.length})` : ""}
          </Button>
          <Button
            leftSection={<Plus size={14} />}
            onClick={() => setAdding((value) => !value)}
          >
            Add repository
          </Button>
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Library actions"
              >
                <MoreHorizontal size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                disabled={mutation.isPending || !statuses.length}
                onClick={() =>
                  run("Checking saved repositories", () => bulk("check"))
                }
              >
                Check all saved repositories
              </Menu.Item>
              <Menu.Item
                disabled={
                  mutation.isPending ||
                  !statuses.some(
                    (status) =>
                      status.missingPaths.length &&
                      isHfCommitSha(status.entry.revision) &&
                      !jobFor(status),
                  )
                }
                onClick={() =>
                  run("Queueing missing files", () => bulk("download"))
                }
              >
                Download missing saved files
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      <Collapse expanded={adding}>
        <Paper withBorder p="md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run("Adding repository", async () => {
                const parsed = parseHfRepoInput(repoInput);
                if (!parsed)
                  throw new Error("Enter a Hugging Face repository ID or URL");
                const result = await createModelLibraryEntry({
                  repoId: parsed.repoId,
                  revision: parsed.revision ?? revision,
                  paths: [],
                  destDir: null,
                });
                setOpened(result.data.id);
                setRepoInput("");
                setAdding(false);
              });
            }}
          >
            <Stack gap="sm">
              <Text size="sm">
                Save a repository to follow its changes, then choose any files
                you want to keep.
              </Text>
              <TextInput
                label="Repository"
                placeholder="owner/model or Hugging Face URL"
                value={repoInput}
                onChange={(event) => setRepoInput(event.currentTarget.value)}
              />
              <Group align="end">
                <TextInput
                  label="Branch or revision"
                  value={revision}
                  onChange={(event) => setRevision(event.currentTarget.value)}
                  flex={1}
                />
                <Button
                  type="submit"
                  disabled={
                    !repoInput.trim() || !revision.trim() || mutation.isPending
                  }
                >
                  Save repository
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      </Collapse>
      <Group align="end">
        <TextInput
          placeholder="Search repositories"
          aria-label="Search model library"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          flex={1}
          miw={180}
        />
        <Select
          aria-label="Filter model library"
          value={filter}
          onChange={(value) => setFilter(value ?? "all")}
          data={[
            { value: "all", label: "All repositories" },
            { value: "saved", label: "Saved" },
            { value: "installed", label: "On disk" },
            { value: "missing", label: "Missing files" },
            { value: "changes", label: "Repository updates" },
          ]}
          w={200}
        />
      </Group>
      {mutation.isPending && <Text size="sm">{mutation.variables.label}…</Text>}
      {(library.error || downloads.error) && (
        <Alert color="red">
          {library.error?.message ?? downloads.error?.message}
        </Alert>
      )}
      {library.isPending && <Text c="dimmed">Loading model library…</Text>}
      {!library.isPending && !filtered.length && (
        <Paper withBorder p="lg">
          <Text>
            {rows.length
              ? "No repositories match these filters."
              : "Your library is empty. Add a repository to follow it or browse Hugging Face to download models."}
          </Text>
          {rows.length > 0 && (
            <Button
              variant="subtle"
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              Clear filters
            </Button>
          )}
        </Paper>
      )}
      {filtered.map(({ status, repo }) => {
        const id = status?.entry.repoId ?? repo!.repoId;
        const job = status
          ? jobFor(status)
          : activeJobs.find((job) => job.destDir === repo!.dir);
        const stateLabel =
          status?.state === "watching"
            ? "Watching only"
            : status?.state === "missing"
              ? "Not installed"
              : status?.state === "partial"
                ? "Partly installed"
                : "On disk";
        const checkLabel =
          status?.check.status === "changed"
            ? "Repository updated"
            : status?.check.status === "current"
              ? "Up to date"
              : status?.check.status === "error"
                ? "Check failed"
                : "Not checked";
        return (
          <Paper withBorder p="md" key={status?.entry.id ?? repo!.dir}>
            <Stack gap="xs">
              <Group justify="space-between" align="start">
                <Stack gap={3} style={{ minWidth: 0 }}>
                  <Anchor
                    href={`https://huggingface.co/${id}`}
                    target="_blank"
                    rel="noreferrer"
                    fw={600}
                    className="text-wrap"
                  >
                    {id}
                  </Anchor>
                  <Group gap="xs">
                    <Badge
                      color={
                        status?.state === "missing" ||
                        status?.state === "partial"
                          ? "yellow"
                          : "gray"
                      }
                      variant="light"
                    >
                      {stateLabel}
                    </Badge>
                    {!status && <Badge variant="outline">Not saved</Badge>}
                    {job && <Badge color="blue">{job.status}</Badge>}
                    {repo && (
                      <Text size="xs" c="dimmed">
                        {formatBytes(diskBytes(repo))} on disk
                      </Text>
                    )}
                  </Group>
                </Stack>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      aria-label={`Actions for ${id}`}
                    >
                      <MoreHorizontal size={18} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {repo && (
                      <Menu.Item
                        disabled={!!job}
                        onClick={() => setDeleteDir(repo.dir)}
                      >
                        Free up disk space…
                      </Menu.Item>
                    )}
                    {status && (
                      <Menu.Item
                        color="red"
                        disabled={mutation.isPending}
                        onClick={() =>
                          run("Removing saved entry", () =>
                            deleteModelLibraryEntry(status.entry.id),
                          )
                        }
                      >
                        Remove saved entry (keep local files)
                      </Menu.Item>
                    )}
                  </Menu.Dropdown>
                </Menu>
              </Group>
              {!!repo?.variants?.length && (
                <Group gap={6}>
                  {repo.variants.map((variant) => (
                    <Badge
                      key={variant.paths[0]}
                      color={
                        variant.paths.some(
                          (path) =>
                            !repo.files.some(
                              (file) => file.path === path && file.present,
                            ),
                        )
                          ? "gray"
                          : "teal"
                      }
                      variant="light"
                    >
                      {hfVariantChipLabel(variant)} ·{" "}
                      {formatBytes(variant.totalBytes)}
                    </Badge>
                  ))}
                </Group>
              )}
              {status && (
                <>
                  <Group gap="xs">
                    <Text size="xs">
                      {countLabel(status.entry.paths.length, "saved file")} ·
                      Pinned
                    </Text>
                    <Code>{status.entry.revision.slice(0, 12)}</Code>
                    <Text size="xs" c="dimmed">
                      Watching {status.entry.watchRevision}
                    </Text>
                  </Group>
                  <Group gap="xs">
                    <Badge
                      variant="outline"
                      color={
                        status.check.status === "changed"
                          ? "yellow"
                          : status.check.status === "error"
                            ? "red"
                            : "gray"
                      }
                    >
                      {checkLabel}
                    </Badge>
                    {status.check.changes.length > 0 && (
                      <Text size="xs">
                        {countLabel(status.check.changes.length, "file change")}
                      </Text>
                    )}
                    {status.check.checkedAt && (
                      <Text size="xs" c="dimmed">
                        Checked {formatLocalDateTime(status.check.checkedAt)}
                      </Text>
                    )}
                  </Group>
                  {(status.revisionMatch === false ||
                    status.driftPaths.length > 0) && (
                    <Text size="xs" c="orange">
                      Installed files differ from the pinned version.
                    </Text>
                  )}
                  {status.check.error && (
                    <Alert color="red">{status.check.error}</Alert>
                  )}
                </>
              )}
              <Group gap="xs">
                {status ? (
                  <>
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
                      leftSection={<RefreshCw size={14} />}
                      disabled={mutation.isPending}
                      onClick={() =>
                        run(`Checking ${id}`, () =>
                          actOnModelLibraryEntry(status.entry.id, {
                            action: "check",
                          }),
                        )
                      }
                    >
                      Check updates
                    </Button>
                    {status.missingPaths.length > 0 && (
                      <Button
                        size="xs"
                        disabled={
                          mutation.isPending ||
                          !!job ||
                          !isHfCommitSha(status.entry.revision)
                        }
                        onClick={() =>
                          run(`Queueing ${id}`, () => downloadMissing(status))
                        }
                      >
                        Download missing
                      </Button>
                    )}
                  </>
                ) : (
                  <Button
                    size="xs"
                    disabled={mutation.isPending}
                    onClick={() =>
                      run(`Saving ${id}`, () =>
                        createModelLibraryEntry({
                          repoId: id,
                          revision: repo!.revision,
                          paths: repo!.files.map((file) => file.path),
                          destDir: repo!.dir,
                        }),
                      )
                    }
                  >
                    Save to library
                  </Button>
                )}
                {repo && (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setDetailDir(repo.dir)}
                  >
                    Manage local files
                  </Button>
                )}
              </Group>
            </Stack>
          </Paper>
        );
      })}
      {active && (
        <ModelLibraryDialog
          key={active.entry.id}
          status={active}
          onClose={() => setOpened(null)}
        />
      )}
      <HfRepoDetailModal
        repo={repos.find((repo) => repo.dir === detailDir) ?? null}
        onClose={() => setDetailDir(null)}
      />
      {deleteRepo && (
        <HfRepoDeleteModal
          repo={deleteRepo}
          request={{ paths: null, bytes: diskBytes(deleteRepo) }}
          onClose={() => setDeleteDir(null)}
          onDeleted={() => setDeleteDir(null)}
        />
      )}
    </Stack>
  );
}
