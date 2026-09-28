import {
  isHfCommitSha,
  parseHfRepoInput,
  type HfDownloadedRepo,
  type ModelLibraryCheck,
  type ModelLibraryEntryState,
  type ModelLibraryEntryStatus,
} from "@arriero/core";
import {
  ActionIcon,
  Alert,
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useLabeledOperation } from "../utils/use-labeled-operation";
import { HfRepoLink } from "./HfBadges";
import { ModelLibraryDialog } from "./ModelLibraryDialog";
import { HfRepoDeleteModal } from "./HfRepoDeleteModal";
import {
  hfOpenJobs,
  hfQueueJobForDir,
  hfQueueJobForRepo,
  useHfJobsSync,
  useHfQueueQuery,
} from "./use-hf-queue";

type LabeledColor = { label: string; color: string };

const ENTRY_STATE_BADGE: Record<ModelLibraryEntryState, LabeledColor> = {
  watching: { label: "Watching only", color: "gray" },
  satisfied: { label: "On disk", color: "gray" },
  partial: { label: "Partly installed", color: "yellow" },
  missing: { label: "Not installed", color: "yellow" },
};

const CHECK_BADGE: Record<ModelLibraryCheck["status"], LabeledColor> = {
  unchecked: { label: "Not checked", color: "gray" },
  current: { label: "Up to date", color: "gray" },
  changed: { label: "Repository updated", color: "yellow" },
  error: { label: "Check failed", color: "red" },
};

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
  const queue = useHfQueueQuery().data?.data ?? null;
  const [repoInput, setRepoInput] = useState("");
  const [revision, setRevision] = useState("main");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [opened, setOpened] = useState<{
    id: string | null;
    dir: string | null;
  } | null>(null);
  const [deleteDir, setDeleteDir] = useState<string | null>(null);
  const statuses = library.data?.data ?? [];
  const repos = downloads.data?.data ?? [];
  const active = opened
    ? (statuses.find((status) =>
        opened.id
          ? status.entry.id === opened.id
          : status.matchedDir === opened.dir,
      ) ?? null)
    : null;
  const activeRepo = opened
    ? (repos.find((repo) => repo.dir === (opened.dir ?? active?.matchedDir)) ??
      null)
    : null;
  const activeJobs = hfOpenJobs(queue);
  const jobFor = (status: ModelLibraryEntryStatus) =>
    hfQueueJobForRepo(queue, status.entry.repoId, status.entry.destDir);
  const canDownloadMissing = (status: ModelLibraryEntryStatus) =>
    status.missingPaths.length > 0 &&
    isHfCommitSha(status.entry.revision) &&
    !jobFor(status);
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
  const operation = useLabeledOperation({
    onSuccess: refresh,
    onError: notifyError("Model library"),
  });
  const { run } = operation;
  const downloadMissing = async (status: ModelLibraryEntryStatus) => {
    if (!canDownloadMissing(status)) return;
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
                disabled={operation.pending || !statuses.length}
                onClick={() =>
                  run("Checking saved repositories", () => bulk("check"))
                }
              >
                Check all saved repositories
              </Menu.Item>
              <Menu.Item
                disabled={
                  operation.pending || !statuses.some(canDownloadMissing)
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
                setOpened({ id: result.data.id, dir: null });
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
                    !repoInput.trim() || !revision.trim() || operation.pending
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
      {operation.pendingLabel !== null && (
        <Text size="sm">{operation.pendingLabel}…</Text>
      )}
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
          : hfQueueJobForDir(queue, repo!.dir);
        const stateBadge = ENTRY_STATE_BADGE[status?.state ?? "satisfied"];
        return (
          <Paper withBorder p="md" key={status?.entry.id ?? repo!.dir}>
            <Stack gap="xs">
              <Group justify="space-between" align="start">
                <Stack gap={3} style={{ minWidth: 0 }}>
                  <HfRepoLink repoId={id} />
                  <Group gap="xs">
                    <Badge color={stateBadge.color} variant="light">
                      {stateBadge.label}
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
                        disabled={operation.pending}
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
                      color={CHECK_BADGE[status.check.status].color}
                    >
                      {CHECK_BADGE[status.check.status].label}
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
                      onClick={() =>
                        setOpened({
                          id: status.entry.id,
                          dir: repo?.dir ?? null,
                        })
                      }
                    >
                      Open repository
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<RefreshCw size={14} />}
                      disabled={operation.pending}
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
                          operation.pending || !canDownloadMissing(status)
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
                    disabled={operation.pending}
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
                {!status && repo && (
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => setOpened({ id: null, dir: repo.dir })}
                  >
                    Open repository
                  </Button>
                )}
              </Group>
            </Stack>
          </Paper>
        );
      })}
      {opened && (active || activeRepo) && (
        <ModelLibraryDialog
          key={opened.id ?? opened.dir}
          status={active}
          repo={activeRepo}
          onClose={() => setOpened(null)}
        />
      )}
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
