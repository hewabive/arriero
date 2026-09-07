import {
  isHfCommitSha,
  type HfDownloadIntegrity,
  type HfDownloadedRepo,
  type ModelLibraryEntryStatus,
} from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Menu,
  Modal,
  Progress,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import {
  actOnModelLibraryEntry,
  browseHfRepo,
  checkHfDownloadIntegrity,
  createModelLibraryEntry,
  getHfDestCheck,
  getModelLibrarySnapshot,
} from "../../api/hf";
import { libraryFiles } from "../utils/model-library-files";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";
import { formatBytes } from "../utils/models";
import { formatLocalDateTime } from "../utils/time";
import { HfRepoDeleteModal, type HfDeleteRequest } from "./HfRepoDeleteModal";
import { hfQueueJobForDir, useHfQueue } from "./use-hf-queue";
import { hfJobPercent, hfJobProgressLine } from "./HfQueueJobCard";
import { ModelLibraryTree } from "./ModelLibraryTree";
import { ModelLibraryFileDetails } from "./ModelLibraryFileDetails";

export function ModelLibraryDialog({
  status,
  repo,
  onClose,
}: {
  status: ModelLibraryEntryStatus | null;
  repo: HfDownloadedRepo | null;
  onClose: () => void;
}) {
  const entry = status?.entry ?? null;
  const repoId = entry?.repoId ?? repo!.repoId;
  const revision = entry?.revision ?? repo!.revision;
  const client = useQueryClient();
  const mobile = useMediaQuery("(max-width: 700px)");
  const [version, setVersion] = useState("pinned");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [inspected, setInspected] = useState<string | null>(null);
  const [pinPreview, setPinPreview] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<HfDeleteRequest | null>(
    null,
  );
  const [integrity, setIntegrity] = useState<HfDownloadIntegrity | null>(null);
  const queue = useHfQueue();
  const pinned = useQuery({
    queryKey: ["hf-library-snapshot", entry?.id ?? repo?.dir, revision],
    queryFn: async () => {
      if (entry) return (await getModelLibrarySnapshot(entry.id)).data;
      const result = (await browseHfRepo(repoId, revision)).data;
      if (result.truncated)
        throw new Error("The repository file listing is incomplete.");
      return {
        revision: result.commitSha,
        files: result.files.map((file) => ({
          path: file.path,
          size: file.size,
          oid: file.oid,
          lfsOid: file.lfs?.oid ?? null,
        })),
      };
    },
    retry: false,
  });
  const destination = repo?.dir ?? entry?.destDir ?? null;
  const dest = useQuery({
    queryKey: ["hf-dest-check", repoId, destination],
    queryFn: () =>
      getHfDestCheck(destination ? { dir: destination } : { repo: repoId }),
  });
  const dir = destination ?? dest.data?.data.dir ?? null;
  const job = dir ? hfQueueJobForDir(queue.state, dir) : null;
  const latest = status?.check.snapshot ?? null;
  const target = (version === "latest" ? latest : pinned.data) ?? null;
  const files = useMemo(
    () =>
      libraryFiles({
        entry,
        repo,
        pinned: pinned.data ?? null,
        latest,
        source: target,
        changes: status?.check.changes ?? [],
        integrity,
        job,
      }),
    [
      entry,
      repo,
      pinned.data,
      latest,
      target,
      status?.check.changes,
      integrity,
      job,
    ],
  );
  const visible = useMemo(
    () =>
      files.filter(
        (file) =>
          file.path.toLowerCase().includes(search.toLowerCase()) &&
          (filter === "all" ||
            (filter === "saved" && file.saved) ||
            (filter === "local" && (file.present || file.partialBytes > 0)) ||
            (filter === "missing" && file.saved && !file.present) ||
            (filter === "changes" && file.change) ||
            (filter === "issues" && file.issue) ||
            (filter === "selected" && selection.has(file.path))),
      ),
    [files, search, filter, selection],
  );
  const visiblePaths = new Set(visible.map((file) => file.path));
  const selected = files.filter((file) => selection.has(file.path));
  const downloadable = selected.filter((file) => file.remote);
  const downloads = downloadable.filter((file) => file.downloadNeeded);
  const deletable = selected.filter(
    (file) =>
      (file.installed && (file.present || file.partialBytes > 0)) ||
      file.orphan,
  );
  const deleteBytes = deletable.reduce(
    (sum, file) => sum + file.deleteBytes,
    0,
  );
  const downloadBytes = downloads.reduce(
    (sum, file) => sum + file.remainingBytes,
    0,
  );
  const additions = downloadable
    .filter((file) => !file.saved)
    .map((file) => file.path);
  const removals = selected
    .filter((file) => file.saved)
    .map((file) => file.path);
  const knownPaths = new Set(target?.files.map((file) => file.path));
  const pinRemoved = entry?.paths.filter((path) => !knownPaths.has(path)) ?? [];
  const pinPaths = [
    ...new Set([
      ...(entry?.paths.filter((path) => knownPaths.has(path)) ?? []),
      ...downloadable.map((file) => file.path),
    ]),
  ];
  const savedPaths = [...new Set([...(entry?.paths ?? []), ...additions])];
  const tooManySaved = savedPaths.length > 2000;
  const freeBytes = dest.data?.data.freeBytes ?? null;
  const mutation = useMutation({
    mutationFn: async (input: { label: string; run: () => Promise<unknown> }) =>
      input.run(),
    onSuccess: async (_result, input) => {
      await Promise.all(
        ["hf-library", "hf-downloads", "hf-queue", "hf-dest-check"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      notifications.show({ message: input.label });
    },
    onError: (error) => {
      void client.invalidateQueries({ queryKey: ["hf-library"] });
      void client.invalidateQueries({ queryKey: ["hf-downloads"] });
      notifyError("Repository")(error);
    },
  });
  const busy = mutation.isPending;
  const run = (label: string, operation: () => Promise<unknown>) =>
    mutation.mutate({ label, run: operation });
  const createSaved = (paths: string[]) =>
    createModelLibraryEntry({
      repoId,
      revision: target?.revision ?? revision,
      paths,
      destDir: dir,
    });
  const savePaths = async (paths: string[]) => {
    if (entry) {
      await actOnModelLibraryEntry(entry.id, {
        action: "select",
        revision: target!.revision,
        paths,
      });
    } else await createSaved(paths);
  };
  const saveAndDownload = async () => {
    const paths = downloads.map((file) => file.path);
    setIntegrity(null);
    if (entry) {
      if (additions.length) await savePaths(savedPaths);
      await actOnModelLibraryEntry(entry.id, {
        action: "download",
        revision: revision,
        paths,
      });
    } else {
      const saved = await createSaved(downloadable.map((file) => file.path));
      await actOnModelLibraryEntry(saved.data.id, {
        action: "download",
        revision: saved.data.revision,
        paths,
      });
    }
  };
  const toggle = (paths: string[], checked: boolean) =>
    setSelection((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (checked) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  const differentVersion = !!target && target.revision !== revision;
  const needsPin = differentVersion || !isHfCommitSha(revision);
  const inspectedFile = files.find((file) => file.path === inspected);
  const checkUpdates = async () => {
    const id =
      entry?.id ??
      (await createSaved(repo?.files.map((file) => file.path) ?? [])).data.id;
    await actOnModelLibraryEntry(id, { action: "check" });
  };
  const selectionLabel = countLabel(selection.size, "selected file");
  return (
    <Modal
      opened
      onClose={onClose}
      title={
        <Anchor
          href={`https://huggingface.co/${repoId}`}
          target="_blank"
          rel="noreferrer"
          fw={600}
          className="text-wrap"
        >
          {repoId}
        </Anchor>
      }
      size="min(1200px, 96vw)"
      fullScreen={!!mobile}
      styles={{ body: { overflow: "hidden" } }}
    >
      <div className="library-repository-body">
        <Stack gap={5}>
          <Group justify="space-between" align="end">
            <Select
              label="File version"
              aria-label="File version"
              value={version}
              w={300}
              maw="100%"
              onChange={(value) => {
                setVersion(value ?? "pinned");
                setPinPreview(false);
              }}
              disabled={busy}
              data={[
                {
                  value: "pinned",
                  label: `${entry ? "Pinned" : "Downloaded"} · ${revision.slice(0, 12)}`,
                },
                {
                  value: "latest",
                  label: `Latest checked · ${latest?.revision.slice(0, 12) ?? "not checked"}`,
                  disabled: !latest,
                },
              ]}
            />
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                leftSection={<RefreshCw size={14} />}
                disabled={busy}
                onClick={() => run("Repository check completed", checkUpdates)}
              >
                {entry ? "Check updates" : "Save and check updates"}
              </Button>
              <Menu position="bottom-end">
                <Menu.Target>
                  <ActionIcon variant="subtle" aria-label="Repository actions">
                    <MoreHorizontal size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    disabled={!repo || !!job || busy}
                    onClick={() =>
                      run("Integrity check completed", async () => {
                        setIntegrity(null);
                        const result = await checkHfDownloadIntegrity(
                          repo!.dir,
                        );
                        setIntegrity(result.data);
                      })
                    }
                  >
                    Verify files
                  </Menu.Item>
                  <Menu.Item
                    disabled={!repo?.orphanParts.length || !!job || busy}
                    onClick={() => {
                      setSelection(
                        new Set(repo!.orphanParts.map((part) => part.path)),
                      );
                      setFilter("selected");
                    }}
                  >
                    Select download leftovers
                  </Menu.Item>
                  <Menu.Item
                    color="red"
                    disabled={!repo || !!job || busy}
                    onClick={() =>
                      setDeleteRequest({ paths: null, bytes: repo!.totalBytes })
                    }
                  >
                    Free up all disk space…
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              Watching {entry?.watchRevision ?? "main"}
              {status?.check.checkedAt
                ? ` · Checked ${formatLocalDateTime(status.check.checkedAt)}`
                : ""}
            </Text>
            {latest && (
              <>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color={status?.check.status === "changed" ? "orange" : "gray"}
                  onClick={() => setFilter("changes")}
                >
                  {status?.check.changes.length
                    ? `${countLabel(status.check.changes.length, "change")} since review`
                    : status?.check.status === "changed"
                      ? "Revision changed; files unchanged"
                      : "No changes since review"}
                </Button>
                {status?.check.status === "changed" && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    disabled={busy}
                    onClick={() =>
                      run(
                        "Changes marked as reviewed; pinned version preserved",
                        () =>
                          actOnModelLibraryEntry(entry!.id, {
                            action: "acknowledge",
                            revision: latest.revision,
                          }),
                      )
                    }
                  >
                    Mark reviewed
                  </Button>
                )}
              </>
            )}
          </Group>
          <Text size="xs" c="dimmed" className="text-wrap">
            {dir ?? "Resolving destination…"}
            {freeBytes !== null ? ` · ${formatBytes(freeBytes)} free` : ""}
          </Text>
        </Stack>
        {(pinned.error || status?.check.error) && (
          <Alert color="yellow" p="xs">
            {pinned.error?.message ?? status?.check.error} Local files remain
            available for management.
          </Alert>
        )}
        {busy && (
          <Text size="xs" c="dimmed">
            Working…
          </Text>
        )}
        {job && (
          <Stack gap={3}>
            <Group justify="space-between">
              <Text size="xs">
                {job.status} ·{" "}
                {hfJobProgressLine(
                  job,
                  queue.active?.id === job.id ? queue.rate : null,
                )}
              </Text>
              <Group gap={4}>
                {job.status === "paused" ? (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => queue.resume(job.id)}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => queue.pause(job.id)}
                  >
                    Pause
                  </Button>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => queue.cancel(job.id)}
                >
                  Cancel download
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={
                    !selected.some(
                      (file) =>
                        file.transfer?.status === "pending" ||
                        file.transfer?.status === "downloading",
                    )
                  }
                  onClick={() =>
                    queue.skipFiles(
                      job.id,
                      selected
                        .filter(
                          (file) =>
                            file.transfer?.status === "pending" ||
                            file.transfer?.status === "downloading",
                        )
                        .map((file) => file.path),
                    )
                  }
                >
                  Skip selected
                </Button>
              </Group>
            </Group>
            <Progress size={3} value={hfJobPercent(job) ?? 0} />
          </Stack>
        )}
        {integrity && (
          <Text size="xs" c={integrity.status === "verified" ? "teal" : "red"}>
            Integrity:{" "}
            {countLabel(
              integrity.files.filter((file) => file.status === "verified")
                .length,
              "verified file",
            )}{" "}
            ·{" "}
            {countLabel(
              integrity.files.filter((file) => file.status !== "verified")
                .length,
              "issue",
            )}{" "}
            · {formatLocalDateTime(integrity.checkedAt)}
          </Text>
        )}
        <Group gap="xs" wrap="wrap">
          <TextInput
            aria-label="Search repository files"
            placeholder="Search files and folders"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            flex={1}
            miw={160}
          />
          <Select
            aria-label="Filter repository files"
            value={filter}
            onChange={(value) => setFilter(value ?? "all")}
            w={175}
            data={[
              { value: "all", label: "All files" },
              { value: "saved", label: "Saved installation" },
              { value: "local", label: "On disk" },
              { value: "missing", label: "Missing saved files" },
              { value: "changes", label: "Changes since review" },
              { value: "issues", label: "Integrity issues" },
              { value: "selected", label: "Selected files" },
            ]}
          />
        </Group>
        <Group justify="space-between" gap={4}>
          <Group gap="xs">
            <Checkbox
              aria-label="Select matching files"
              disabled={busy || !visible.length}
              checked={
                visible.length > 0 &&
                visible.every((file) => selection.has(file.path))
              }
              indeterminate={
                visible.some((file) => selection.has(file.path)) &&
                !visible.every((file) => selection.has(file.path))
              }
              onChange={(event) =>
                toggle(
                  visible.map((file) => file.path),
                  event.currentTarget.checked,
                )
              }
            />
            <Text size="xs" c="dimmed">
              {countLabel(visible.length, "file")}
            </Text>
          </Group>
          <Group gap={4}>
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={busy || !entry?.paths.length}
              onClick={() => setSelection(new Set(entry!.paths))}
            >
              Select saved
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={busy || !selection.size}
              onClick={() => setSelection(new Set())}
            >
              Clear selection
            </Button>
          </Group>
        </Group>
        <div className="library-repository-scroll">
          {pinned.isPending && (
            <Text size="sm" c="dimmed">
              Loading repository files…
            </Text>
          )}
          <ModelLibraryTree
            files={visible}
            selection={selection}
            onToggle={toggle}
            disabled={busy}
            reveal={!!search || filter !== "all"}
            onInspect={setInspected}
          />
        </div>
        {inspectedFile && (
          <ModelLibraryFileDetails
            file={inspectedFile}
            pinnedKnown={!!pinned.data}
            latestKnown={!!latest}
            onClose={() => setInspected(null)}
          />
        )}
        {pinPreview && target && (
          <Alert
            color="blue"
            p="sm"
            mah={mobile ? 180 : 240}
            style={{ overflow: "auto", flexShrink: 0 }}
          >
            <Stack gap={5}>
              <Text size="sm">
                Pin {target.revision.slice(0, 12)} for this repository's entire
                saved installation ({countLabel(pinPaths.length, "file")}).
                Selected remote files will be added. Local files will be
                downloaded only when requested.
              </Text>
              {pinRemoved.length > 0 && (
                <Text size="xs" c="orange">
                  Absent in this version and removed from the saved
                  installation: {pinRemoved.join(", ")}
                </Text>
              )}
              <Group justify="flex-end">
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => setPinPreview(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  disabled={busy || pinPaths.length > 2000}
                  onClick={() =>
                    run("Installation version pinned", async () => {
                      if (entry)
                        await actOnModelLibraryEntry(entry.id, {
                          action: version === "latest" ? "pin" : "select",
                          revision: target.revision,
                          paths: pinPaths,
                        });
                      else await createSaved(pinPaths);
                      await client.invalidateQueries({
                        queryKey: ["hf-library-snapshot"],
                      });
                      setPinPreview(false);
                      setVersion("pinned");
                    })
                  }
                >
                  Pin version and save
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
        <Stack gap={6} className="library-repository-footer">
          {(tooManySaved ||
            pinPaths.length > 2000 ||
            selection.size > 2000) && (
            <Text size="xs" c="orange">
              A saved installation or file operation supports up to 2000 files.
              Narrow the selection or use smaller folders.
            </Text>
          )}
          <Group justify="space-between" gap="xs">
            <Text size="xs">
              {selectionLabel}
              {selected.some((file) => !visiblePaths.has(file.path))
                ? " (including hidden files)"
                : ""}
            </Text>
            {downloadable.length < selected.length && (
              <Text size="xs" c="dimmed">
                {countLabel(
                  selected.length - downloadable.length,
                  "selected file",
                )}{" "}
                unavailable in this version
              </Text>
            )}
          </Group>
          <Group justify="space-between" gap="xs">
            <Group gap="xs">
              <Menu position="top-start">
                <Menu.Target>
                  <Button
                    variant="default"
                    size="xs"
                    disabled={busy || !target || needsPin}
                  >
                    Saved installation
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    disabled={!additions.length || tooManySaved}
                    onClick={() =>
                      run("Files added to saved installation", () =>
                        savePaths(savedPaths),
                      )
                    }
                  >
                    Add selected files ({additions.length})
                  </Menu.Item>
                  <Menu.Item
                    disabled={!removals.length}
                    onClick={() =>
                      run(
                        "Files removed from saved installation; local files preserved",
                        () =>
                          savePaths(
                            entry!.paths.filter((path) => !selection.has(path)),
                          ),
                      )
                    }
                  >
                    Remove selected files ({removals.length})
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                disabled={
                  busy || !!job || !deletable.length || deletable.length > 2000
                }
                onClick={() =>
                  setDeleteRequest({
                    paths: deletable.map((file) => file.path),
                    bytes: deleteBytes,
                  })
                }
              >
                Delete from disk
                {deletable.length ? ` · ${formatBytes(deleteBytes)}` : ""}
              </Button>
            </Group>
            {needsPin ? (
              <Button
                size="xs"
                disabled={busy || !target}
                onClick={() => {
                  setInspected(null);
                  setPinPreview(true);
                }}
              >
                Pin this version…
              </Button>
            ) : (
              <Tooltip
                label={
                  job
                    ? "A download is already active, queued or paused for this directory"
                    : "Only missing, changed or damaged selected files are downloaded"
                }
              >
                <Button
                  size="xs"
                  disabled={
                    busy ||
                    !!job ||
                    !target ||
                    !downloads.length ||
                    downloads.length > 2000 ||
                    tooManySaved
                  }
                  onClick={() =>
                    run(
                      "Selected files added to download queue",
                      saveAndDownload,
                    )
                  }
                >
                  {additions.length || !entry
                    ? "Save and download"
                    : "Download selected"}
                  {downloads.length ? ` · ${formatBytes(downloadBytes)}` : ""}
                </Button>
              </Tooltip>
            )}
          </Group>
        </Stack>
      </div>
      {repo && (
        <HfRepoDeleteModal
          repo={repo}
          request={deleteRequest}
          onClose={() => setDeleteRequest(null)}
          onDeleted={() => {
            setDeleteRequest(null);
            setIntegrity(null);
            setSelection(new Set());
          }}
        />
      )}
    </Modal>
  );
}
