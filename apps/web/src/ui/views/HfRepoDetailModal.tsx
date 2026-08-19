import {
  HfDownloadDeleteBlockedSchema,
  type HfDownloadStart,
  type HfDownloadedRepo,
  type HfDownloadedRepoFile,
  type HfGgufVariant,
  type HfRepoBrowse,
  type HfTreeFile,
} from "@arriero/core";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Code,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  ApiError,
  browseHfRepo,
  checkHfUpdates,
  deleteHfDownload,
  getHfDestCheck,
  startHfDownload,
} from "../../api/client";
import {
  hfLocalFileState,
  hfLocalVariantState,
  type HfLocalVariantState,
} from "../utils/hf";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";
import {
  hfFileLocalBadge,
  hfRepoMetaLines,
  hfRepoStatusBadges,
} from "./HfBadges";
import { HfVariantCheckbox } from "./HfVariantCheckbox";

type HfFileRowState =
  | "current"
  | "changed"
  | "absent"
  | "missing"
  | "local-only";

type HfFileRow = { path: string; size: number; state: HfFileRowState };

type HfVariantRow = { variant: HfGgufVariant; state: HfLocalVariantState };

type HfDetailRows = {
  variants: HfVariantRow[];
  files: HfFileRow[];
  localOnly: HfFileRow[];
  downloadable: ReadonlyMap<string, number>;
};

function byPath(a: { path: string }, b: { path: string }) {
  return a.path.localeCompare(b.path);
}

function remoteRowState(
  file: HfTreeFile,
  localFiles: ReadonlyMap<string, HfDownloadedRepoFile>,
): HfFileRowState {
  const entry = localFiles.get(file.path);
  if (entry && !entry.present) {
    return "missing";
  }
  return hfLocalFileState(file, localFiles);
}

function manifestRows(repo: HfDownloadedRepo): HfDetailRows {
  const localFiles = new Map(repo.files.map((file) => [file.path, file]));
  const variantPaths = new Set(
    (repo.variants ?? []).flatMap((variant) => variant.paths),
  );
  const variants = (repo.variants ?? []).map((variant) => {
    const presentCount = variant.paths.filter(
      (path) => localFiles.get(path)?.present === true,
    ).length;
    const state: HfLocalVariantState =
      presentCount === variant.paths.length
        ? "on-disk"
        : presentCount > 0
          ? "partial"
          : null;
    return { variant, state };
  });
  const files = repo.files
    .filter((file) => !variantPaths.has(file.path))
    .map(
      (file): HfFileRow => ({
        path: file.path,
        size: file.size,
        state: file.present ? "current" : "missing",
      }),
    )
    .sort(byPath);
  return { variants, files, localOnly: [], downloadable: new Map() };
}

function browseRows(
  repo: HfDownloadedRepo,
  browse: HfRepoBrowse,
): HfDetailRows {
  const localFiles = new Map(repo.files.map((file) => [file.path, file]));
  const fileByPath = new Map(browse.files.map((file) => [file.path, file]));
  const variantPaths = new Set(
    (browse.ggufVariants ?? []).flatMap((variant) => variant.paths),
  );
  const variants = (browse.ggufVariants ?? []).map((variant) => ({
    variant,
    state: hfLocalVariantState(variant.paths, fileByPath, localFiles),
  }));
  const files: HfFileRow[] = [];
  const downloadable = new Map<string, number>();
  for (const file of browse.files) {
    const state = remoteRowState(file, localFiles);
    if (state !== "current") {
      downloadable.set(file.path, file.size);
    }
    if (!variantPaths.has(file.path)) {
      files.push({ path: file.path, size: file.size, state });
    }
  }
  files.sort(byPath);
  const localOnly = repo.files
    .filter((file) => file.present && !fileByPath.has(file.path))
    .map(
      (file): HfFileRow => ({
        path: file.path,
        size: file.size,
        state: "local-only",
      }),
    )
    .sort(byPath);
  return { variants, files, localOnly, downloadable };
}

function FileRows(props: {
  rows: HfFileRow[];
  selection: ReadonlySet<string>;
  onToggle: (paths: readonly string[], checked: boolean) => void;
}) {
  return (
    <ScrollArea.Autosize mah={240} type="auto" offsetScrollbars>
      <Stack gap={2}>
        {props.rows.map((row) => (
          <Checkbox
            key={row.path}
            checked={props.selection.has(row.path)}
            onChange={(event) =>
              props.onToggle([row.path], event.currentTarget.checked)
            }
            label={
              <Group gap="xs" wrap="wrap">
                <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                  {row.path}
                </Text>
                {hfFileLocalBadge(row.state)}
                <Text size="xs" c="dimmed">
                  {formatBytes(row.size)}
                </Text>
              </Group>
            }
          />
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

export function HfRepoDetailModal(props: {
  repo: HfDownloadedRepo | null;
  running: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      opened={props.repo !== null}
      onClose={props.onClose}
      size="xl"
      title={props.repo ? <Text fw={600}>{props.repo.repoId}</Text> : null}
    >
      {props.repo && (
        <HfRepoDetailBody
          key={props.repo.dir}
          repo={props.repo}
          running={props.running}
        />
      )}
    </Modal>
  );
}

function HfRepoDetailBody(props: { repo: HfDownloadedRepo; running: boolean }) {
  const { repo } = props;
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [deleteRequest, setDeleteRequest] = useState<{
    paths: string[] | null;
  } | null>(null);
  const [verifyUpstream, setVerifyUpstream] = useState(true);

  const browseQuery = useQuery({
    queryKey: ["hf-browse", repo.repoId, ""],
    queryFn: () => browseHfRepo(repo.repoId),
    retry: false,
    staleTime: 60_000,
  });
  const browse = browseQuery.data?.data ?? null;

  const destQuery = useQuery({
    queryKey: ["hf-dest-check", repo.repoId, repo.dir],
    queryFn: () => getHfDestCheck({ dir: repo.dir }),
  });
  const freeBytes = destQuery.data?.data.freeBytes ?? null;

  const rows = useMemo(
    () => (browse ? browseRows(repo, browse) : manifestRows(repo)),
    [repo, browse],
  );
  const deletableBytes = useMemo(
    () =>
      new Map(
        repo.files
          .filter((file) => file.present)
          .map((file) => [file.path, file.size]),
      ),
    [repo],
  );

  const selectedDownload = [...selection].filter((path) =>
    rows.downloadable.has(path),
  );
  const selectedDownloadBytes = selectedDownload.reduce(
    (sum, path) => sum + (rows.downloadable.get(path) ?? 0),
    0,
  );
  const selectedDelete = [...selection].filter((path) =>
    deletableBytes.has(path),
  );
  const selectedDeleteBytes = selectedDelete.reduce(
    (sum, path) => sum + (deletableBytes.get(path) ?? 0),
    0,
  );
  const allBytes = [...rows.downloadable.values()].reduce(
    (sum, size) => sum + size,
    0,
  );
  const updatedPaths = repo.update.files
    .filter((file) => file.status === "updated")
    .map((file) => file.path);
  const fits = (bytes: number) => freeBytes === null || bytes <= freeBytes;

  const invalidateDownloads = () =>
    queryClient.invalidateQueries({ queryKey: ["hf-downloads"] });

  const checkMutation = useMutation({
    mutationFn: () => checkHfUpdates([repo.dir]),
    onSuccess: () => void invalidateDownloads(),
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Update check",
        message: (error as Error).message,
      }),
  });

  const downloadMutation = useMutation({
    mutationFn: (input: HfDownloadStart) => startHfDownload(input),
    onSuccess: (result, input) => {
      setSelection((previous) => {
        const next = new Set(previous);
        for (const path of input.paths) {
          next.delete(path);
        }
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["hf-download-jobs"] });
      notifications.show({
        title: "Download started",
        message: `${result.data.repoId}: ${countLabel(result.data.files.length, "file")}, ${formatBytes(result.data.totalBytes)}`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Download",
        message: (error as Error).message,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteHfDownload,
    onSuccess: (_result, input) => {
      setDeleteRequest(null);
      setSelection((previous) => {
        if (!input.paths) {
          return new Set();
        }
        const next = new Set(previous);
        for (const path of input.paths) {
          next.delete(path);
        }
        return next;
      });
      void invalidateDownloads();
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      notifications.show({
        title: input.paths ? "Files deleted" : "Download deleted",
        message: input.paths
          ? `${countLabel(input.paths.length, "file")} removed from disk.`
          : "The repository directory was removed.",
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 412) {
        return;
      }
      notifications.show({
        color: "red",
        title: "Delete download",
        message: (error as Error).message,
      });
    },
  });

  function togglePaths(paths: readonly string[], checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (checked) {
          next.add(path);
        } else {
          next.delete(path);
        }
      }
      return next;
    });
  }

  function selectAll() {
    setSelection(
      new Set([
        ...rows.variants.flatMap((row) => row.variant.paths),
        ...rows.files.map((row) => row.path),
        ...rows.localOnly.map((row) => row.path),
      ]),
    );
  }

  function startDownload(paths: string[]) {
    if (!browse || paths.length === 0) {
      return;
    }
    downloadMutation.mutate({
      repoId: repo.repoId,
      revision: browse.commitSha,
      paths,
      destDir: repo.dir,
    });
  }

  function openDelete(paths: string[] | null) {
    deleteMutation.reset();
    setVerifyUpstream(true);
    setDeleteRequest({ paths });
  }

  const verifyError =
    deleteMutation.error instanceof ApiError &&
    deleteMutation.error.status === 412
      ? deleteMutation.error
      : null;
  const verifyBlockedParsed = verifyError
    ? HfDownloadDeleteBlockedSchema.safeParse(verifyError.body)
    : null;
  const blockedFiles = verifyBlockedParsed?.success
    ? verifyBlockedParsed.data.verification.files.filter(
        (file) =>
          file.status === "deleted" &&
          (deleteRequest?.paths?.includes(file.path) ?? true),
      )
    : [];
  const deleteBytes = deleteRequest?.paths
    ? deleteRequest.paths.reduce(
        (sum, path) => sum + (deletableBytes.get(path) ?? 0),
        0,
      )
    : repo.totalBytes;

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="wrap">
        {hfRepoStatusBadges(repo, props.running)}
        <Anchor
          size="xs"
          href={`https://huggingface.co/${repo.repoId}`}
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          huggingface.co
          <ExternalLink size={12} />
        </Anchor>
      </Group>
      {hfRepoMetaLines(repo)}

      <Group gap="xs" wrap="wrap">
        <Button
          variant="default"
          size="xs"
          leftSection={<RefreshCw size={14} />}
          loading={checkMutation.isPending}
          onClick={() => checkMutation.mutate()}
        >
          Check updates
        </Button>
        {repo.update.status === "drift" && updatedPaths.length > 0 && (
          <Button
            size="xs"
            variant="light"
            leftSection={<Download size={14} />}
            loading={downloadMutation.isPending}
            disabled={props.running}
            onClick={() =>
              downloadMutation.mutate({
                repoId: repo.repoId,
                revision: repo.update.revisionSha ?? "main",
                paths: updatedPaths,
                destDir: repo.dir,
              })
            }
          >
            Download updates · {countLabel(updatedPaths.length, "file")}
          </Button>
        )}
        {browse && rows.downloadable.size > 0 && (
          <Button
            size="xs"
            leftSection={<Download size={14} />}
            loading={downloadMutation.isPending}
            disabled={props.running || !fits(allBytes)}
            onClick={() => startDownload([...rows.downloadable.keys()])}
          >
            Download all · {formatBytes(allBytes)}
          </Button>
        )}
        {browse && rows.downloadable.size === 0 && (
          <Badge color="green" variant="light">
            all files on disk
          </Badge>
        )}
        <Button
          size="xs"
          color="red"
          variant="light"
          leftSection={<Trash2 size={14} />}
          disabled={props.running}
          onClick={() => openDelete(null)}
        >
          Delete repository
        </Button>
      </Group>

      {browseQuery.isLoading && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading the upstream file list…
          </Text>
        </Group>
      )}
      {browseQuery.isError && (
        <Alert color="yellow" title="Upstream listing unavailable">
          <Text size="sm">
            {(browseQuery.error as Error).message} Deleting local files still
            works.
          </Text>
        </Alert>
      )}
      {browse?.truncated && (
        <Badge color="yellow" variant="light">
          listing truncated
        </Badge>
      )}

      {rows.variants.length > 0 && (
        <Stack gap={6}>
          <Text fw={600} size="sm">
            GGUF variants
          </Text>
          <ScrollArea.Autosize mah={260} type="auto" offsetScrollbars>
            <Stack gap={4}>
              {rows.variants.map(({ variant, state }) => (
                <HfVariantCheckbox
                  key={variant.paths[0]}
                  variant={variant}
                  state={state}
                  selection={selection}
                  onToggle={togglePaths}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      )}

      {rows.files.length > 0 && (
        <Stack gap={6}>
          <Text fw={600} size="sm">
            {rows.variants.length > 0 ? "Other files" : "Files"}
          </Text>
          <FileRows
            rows={rows.files}
            selection={selection}
            onToggle={togglePaths}
          />
        </Stack>
      )}

      {rows.localOnly.length > 0 && (
        <Stack gap={6}>
          <Text fw={600} size="sm">
            Not in the latest revision
          </Text>
          <FileRows
            rows={rows.localOnly}
            selection={selection}
            onToggle={togglePaths}
          />
        </Stack>
      )}

      <Divider />
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Group gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={selectAll}>
            Select all
          </Button>
          <Button
            variant="subtle"
            size="compact-xs"
            disabled={selection.size === 0}
            onClick={() => setSelection(new Set())}
          >
            Clear
          </Button>
          <Text size="sm" c={fits(selectedDownloadBytes) ? "dimmed" : "red"}>
            {countLabel(selection.size, "file")} selected
            {freeBytes !== null ? ` · free ${formatBytes(freeBytes)}` : ""}
          </Text>
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            leftSection={<Download size={14} />}
            loading={downloadMutation.isPending}
            disabled={
              selectedDownload.length === 0 ||
              props.running ||
              !fits(selectedDownloadBytes)
            }
            onClick={() => startDownload(selectedDownload)}
          >
            Download
            {selectedDownload.length > 0
              ? ` ${countLabel(selectedDownload.length, "file")} · ${formatBytes(selectedDownloadBytes)}`
              : ""}
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            leftSection={<Trash2 size={14} />}
            disabled={selectedDelete.length === 0 || props.running}
            onClick={() => openDelete([...selectedDelete].sort())}
          >
            Delete
            {selectedDelete.length > 0
              ? ` ${countLabel(selectedDelete.length, "file")} · ${formatBytes(selectedDeleteBytes)}`
              : ""}
          </Button>
        </Group>
      </Group>

      <Modal
        opened={deleteRequest !== null}
        onClose={() => setDeleteRequest(null)}
        title={
          deleteRequest?.paths
            ? "Delete downloaded files"
            : "Delete downloaded repository"
        }
      >
        <Stack gap="sm">
          {deleteRequest?.paths ? (
            <>
              <Text size="sm">
                Delete {countLabel(deleteRequest.paths.length, "file")} (
                {formatBytes(deleteBytes)}) from <Code>{repo.repoId}</Code>?
                This removes the files from disk; the rest of the download
                stays.
              </Text>
              <Stack gap={2} mah={140} style={{ overflowY: "auto" }}>
                {deleteRequest.paths.map((path) => (
                  <Text
                    key={path}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {path}
                  </Text>
                ))}
              </Stack>
              {deleteRequest.paths.length === repo.fileCount && (
                <Text size="sm" c="orange">
                  Every file is selected, so the whole repository directory will
                  be removed.
                </Text>
              )}
            </>
          ) : (
            <Text size="sm">
              Delete <Code>{repo.dir}</Code> with{" "}
              {countLabel(repo.fileCount, "file")} (
              {formatBytes(repo.totalBytes)})? This removes the files from disk.
            </Text>
          )}
          {verifyError ? (
            <Alert color="yellow" icon={<AlertTriangle size={16} />}>
              <Stack gap={4}>
                <Text size="sm">{verifyError.message}</Text>
                {blockedFiles.map((file) => (
                  <Text
                    key={file.path}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {file.path}
                  </Text>
                ))}
              </Stack>
            </Alert>
          ) : (
            <Checkbox
              checked={verifyUpstream}
              onChange={(event) =>
                setVerifyUpstream(event.currentTarget.checked)
              }
              label="Verify on Hugging Face before deleting"
              description="Blocks deletion when a file is no longer available upstream and could not be re-downloaded."
            />
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteRequest(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={deleteMutation.isPending}
              onClick={() => {
                const request = deleteRequest;
                if (!request) {
                  return;
                }
                deleteMutation.mutate({
                  dir: repo.dir,
                  ...(request.paths ? { paths: request.paths } : {}),
                  verifyUpstream: verifyError ? false : verifyUpstream,
                });
              }}
            >
              {verifyError ? "Delete anyway" : "Delete"}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
