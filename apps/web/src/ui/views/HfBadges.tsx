import type {
  HfDownloadedRepo,
  HfGgufVariant,
  HfUpdateCheckStatus,
} from "@arriero/core";
import { Badge, Code, Text, Tooltip } from "@mantine/core";

import type { HfLocalFileState, HfLocalVariantState } from "../utils/hf";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";

const UPDATE_BADGE_COLOR: Record<HfUpdateCheckStatus, string> = {
  unchecked: "gray",
  "in-sync": "green",
  drift: "yellow",
  error: "red",
};

function hfUpdateBadge(repo: HfDownloadedRepo) {
  const status = repo.update.status;
  const changed = repo.update.files.filter(
    (file) => file.status !== "current",
  ).length;
  const label =
    status === "drift" && changed > 0 ? `drift · ${changed}` : status;
  const badge = (
    <Badge color={UPDATE_BADGE_COLOR[status]} variant="light">
      {label}
    </Badge>
  );
  if (status === "error" && repo.update.error) {
    return <Tooltip label={repo.update.error}>{badge}</Tooltip>;
  }
  return badge;
}

export function hfFileLocalBadge(
  state: HfLocalFileState | "missing" | "local-only",
) {
  if (state === "current") {
    return (
      <Badge color="green" variant="light">
        on disk
      </Badge>
    );
  }
  if (state === "changed") {
    return (
      <Badge color="yellow" variant="light">
        changed upstream
      </Badge>
    );
  }
  if (state === "missing") {
    return (
      <Badge color="orange" variant="light">
        missing
      </Badge>
    );
  }
  if (state === "local-only") {
    return (
      <Badge color="gray" variant="light">
        not upstream
      </Badge>
    );
  }
  return null;
}

export function hfVariantLocalBadge(state: HfLocalVariantState) {
  if (state === "on-disk") {
    return (
      <Badge color="green" variant="light">
        on disk
      </Badge>
    );
  }
  if (state === "partial") {
    return (
      <Badge color="orange" variant="light">
        partial
      </Badge>
    );
  }
  if (state === "changed") {
    return (
      <Badge color="yellow" variant="light">
        changed upstream
      </Badge>
    );
  }
  return null;
}

export function hfVariantKindBadge(variant: HfGgufVariant) {
  if (variant.kind === "mmproj") {
    return (
      <Badge color="grape" variant="light">
        mmproj
      </Badge>
    );
  }
  return null;
}

function hfMissingFilesBadge(repo: HfDownloadedRepo) {
  if (repo.missingFiles === 0) {
    return null;
  }
  return (
    <Badge color="orange" variant="light">
      {countLabel(repo.missingFiles, "missing file")}
    </Badge>
  );
}

function hfDownloadingBadge(running: boolean) {
  if (!running) {
    return null;
  }
  return (
    <Badge color="blue" variant="light">
      downloading
    </Badge>
  );
}

export function hfRepoStatusBadges(repo: HfDownloadedRepo, running: boolean) {
  return (
    <>
      <Badge color="gray" variant="outline">
        {repo.revision.slice(0, 10)}
      </Badge>
      {hfUpdateBadge(repo)}
      {hfMissingFilesBadge(repo)}
      {hfDownloadingBadge(running)}
    </>
  );
}

export function hfRepoMetaLines(repo: HfDownloadedRepo) {
  return (
    <>
      <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
        <Code>{repo.dir}</Code>
      </Text>
      <Text size="xs" c="dimmed">
        {countLabel(repo.fileCount, "file")} · {formatBytes(repo.totalBytes)} ·
        downloaded {formatLocalDateTime(repo.downloadedAt)}
        {repo.update.checkedAt
          ? ` · checked ${formatLocalDateTime(repo.update.checkedAt)}`
          : ""}
      </Text>
    </>
  );
}
