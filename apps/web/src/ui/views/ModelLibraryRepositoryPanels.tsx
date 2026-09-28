import type { HfDownloadIntegrity, HfDownloadQueueJob } from "@arriero/core";
import { Alert, Button, Group, Progress, Stack, Text } from "@mantine/core";
import {
  FileVerificationProgress,
  verificationPercent,
} from "../components/FileVerificationProgress";
import type { LibraryFile } from "../utils/model-library-files";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";
import { hfJobPercent, hfJobProgressLine } from "./HfQueueJobCard";
import type { HfIntegrity } from "./use-hf-integrity";
import type { HfQueue } from "./use-hf-queue";

export function RepositoryVerificationPanel({
  verification,
}: {
  verification: HfIntegrity;
}) {
  const { job } = verification;
  return (
    <>
      {verification.busy && (
        <Stack gap="xs">
          {job?.verification ? (
            <FileVerificationProgress progress={job.verification} />
          ) : (
            <Text size="sm">Preparing verification…</Text>
          )}
          {job && job.totalFiles > 1 && (
            <Stack gap={3}>
              <Text size="xs" c="dimmed">
                Overall · {job.completedFiles} of{" "}
                {countLabel(job.totalFiles, "file")} checked
              </Text>
              <Progress
                size={3}
                aria-label="Repository verification"
                value={verificationPercent(
                  job.completedBytes + (job.verification?.processedBytes ?? 0),
                  job.totalBytes,
                )}
              />
            </Stack>
          )}
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={!job}
              loading={verification.cancel.isPending}
              onClick={() => verification.cancel.mutate()}
            >
              Cancel verification
            </Button>
            <Text size="xs" c="dimmed">
              You can close this window; verification continues in the
              background.
            </Text>
          </Group>
        </Stack>
      )}
      {verification.error && (
        <Alert color="red" p="xs">
          {verification.error}
        </Alert>
      )}
      {job?.status === "canceled" && (
        <Text size="xs" c="dimmed">
          Verification canceled. No incomplete results were saved.
        </Text>
      )}
    </>
  );
}

export function RepositoryIntegritySummary({
  integrity,
}: {
  integrity: HfDownloadIntegrity;
}) {
  const verified = integrity.files.filter(
    (file) => file.status === "verified",
  ).length;
  return (
    <Text size="xs" c={integrity.status === "verified" ? "teal" : "red"}>
      Integrity: {countLabel(verified, "verified file")} ·{" "}
      {countLabel(integrity.files.length - verified, "issue")} ·{" "}
      {formatLocalDateTime(integrity.checkedAt)}
    </Text>
  );
}

export function DownloadJobStrip({
  job,
  queue,
  selected,
}: {
  job: HfDownloadQueueJob;
  queue: HfQueue;
  selected: LibraryFile[];
}) {
  const skippable = selected
    .filter(
      (file) =>
        file.transfer?.status === "pending" ||
        file.transfer?.status === "downloading",
    )
    .map((file) => file.path);
  return (
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
            disabled={!skippable.length}
            onClick={() => queue.skipFiles(job.id, skippable)}
          >
            Skip selected
          </Button>
        </Group>
      </Group>
      <Progress size={3} value={hfJobPercent(job) ?? 0} />
    </Stack>
  );
}
