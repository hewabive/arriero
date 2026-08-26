import type { HfDownloadStart, HfDownloadedRepo } from "@arriero/core";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  browseHfRepo,
  checkHfUpdates,
  getHfDestCheck,
  startHfDownload,
} from "../../api/client";
import { hfDownloadJobStatusColor } from "../utils/job-status";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";
import { hfRepoMetaLines, hfRepoStatusBadges } from "./HfBadges";
import { hfJobPercent, hfJobProgressLine } from "./HfQueueJobCard";
import { HfRepoDeleteModal, type HfDeleteRequest } from "./HfRepoDeleteModal";
import { browseRows, FileRows, manifestRows } from "./HfRepoDetailRows";
import { HfVariantCheckbox } from "./HfVariantCheckbox";
import {
  hfQueueJobForDir,
  hfRepoJobStateForDir,
  useHfQueue,
} from "./use-hf-queue";
import { notifyError } from "../utils/notify";

export function HfRepoDetailModal(props: {
  repo: HfDownloadedRepo | null;
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
        <HfRepoDetailBody key={props.repo.dir} repo={props.repo} />
      )}
    </Modal>
  );
}

function HfRepoDetailBody(props: { repo: HfDownloadedRepo }) {
  const { repo } = props;
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [deleteRequest, setDeleteRequest] = useState<HfDeleteRequest | null>(
    null,
  );

  const queue = useHfQueue();
  const job = hfQueueJobForDir(queue.state, repo.dir);
  const jobState = hfRepoJobStateForDir(queue.state, repo.dir);
  const jobRate =
    job && queue.active && queue.active.id === job.id ? queue.rate : null;
  const jobPercent = job ? hfJobPercent(job) : null;
  const jobFiles = useMemo(
    () => (job ? new Map(job.files.map((file) => [file.path, file])) : null),
    [job],
  );
  const busy = job !== null;

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

  const checkMutation = useMutation({
    mutationFn: () => checkHfUpdates([repo.dir]),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["hf-downloads"] }),
    onError: notifyError("Update check"),
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
      void queryClient.invalidateQueries({ queryKey: ["hf-queue"] });
      notifications.show({
        title:
          result.data.status === "queued"
            ? "Added to queue"
            : "Download started",
        message: `${result.data.repoId}: ${countLabel(result.data.files.length, "file")}, ${formatBytes(result.data.totalBytes)}`,
      });
    },
    onError: notifyError("Download"),
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

  function openDelete(paths: string[] | null, bytes: number) {
    setDeleteRequest({ paths, bytes });
  }

  const skipJobFile = job
    ? (path: string) => queue.skipFiles(job.id, [path])
    : undefined;

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="wrap">
        {hfRepoStatusBadges(repo, jobState)}
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

      {job && (
        <Stack gap={4}>
          <Group gap="xs" wrap="wrap">
            <Badge color={hfDownloadJobStatusColor(job.status)} variant="light">
              {job.status === "running" ? "downloading" : job.status}
            </Badge>
            <Text size="xs" c="dimmed">
              {hfJobProgressLine(job, jobRate)}
            </Text>
          </Group>
          {jobPercent !== null && (
            <Progress
              value={jobPercent}
              animated={job.status === "running"}
              striped={job.status === "running"}
            />
          )}
        </Stack>
      )}

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
            disabled={busy}
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
            disabled={busy || !fits(allBytes)}
            onClick={() => startDownload([...rows.downloadable.keys()])}
          >
            {busy ? "Queued" : `Download all · ${formatBytes(allBytes)}`}
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
          disabled={busy}
          onClick={() => openDelete(null, repo.totalBytes)}
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
            jobFiles={jobFiles ?? undefined}
            onSkipFile={skipJobFile}
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

      {repo.orphanParts.length > 0 && !busy && (
        <Stack gap={6}>
          <Group gap="xs" wrap="wrap">
            <Text fw={600} size="sm">
              Orphan part files
            </Text>
            <Button
              size="compact-xs"
              color="red"
              variant="subtle"
              leftSection={<Trash2 size={12} />}
              onClick={() =>
                openDelete(
                  repo.orphanParts.map((part) => part.path),
                  repo.orphanParts.reduce(
                    (sum, part) => sum + part.partialBytes,
                    0,
                  ),
                )
              }
            >
              Delete orphan parts
            </Button>
          </Group>
          <Stack gap={2}>
            {repo.orphanParts.map((part) => (
              <Group key={part.path} gap="xs" wrap="nowrap">
                <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                  {part.path}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatBytes(part.partialBytes)}
                </Text>
              </Group>
            ))}
          </Stack>
          <Text size="xs" c="dimmed">
            Leftovers of downloads that never finished — safe to delete; a new
            download resumes from them if kept.
          </Text>
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
              busy ||
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
            disabled={selectedDelete.length === 0 || busy}
            onClick={() =>
              openDelete([...selectedDelete].sort(), selectedDeleteBytes)
            }
          >
            Delete
            {selectedDelete.length > 0
              ? ` ${countLabel(selectedDelete.length, "file")} · ${formatBytes(selectedDeleteBytes)}`
              : ""}
          </Button>
        </Group>
      </Group>

      <HfRepoDeleteModal
        repo={repo}
        request={deleteRequest}
        onClose={() => setDeleteRequest(null)}
        onDeleted={(paths) => {
          setDeleteRequest(null);
          setSelection((previous) => {
            if (!paths) {
              return new Set();
            }
            const next = new Set(previous);
            for (const path of paths) {
              next.delete(path);
            }
            return next;
          });
        }}
      />
    </Stack>
  );
}
