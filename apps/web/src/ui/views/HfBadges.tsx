import type {
  HfDownloadedRepo,
  HfGgufVariant,
  HfUpdateCheckStatus,
} from "@arriero/core";
import { Badge, Tooltip } from "@mantine/core";

import type { HfLocalFileState, HfLocalVariantState } from "../utils/hf";
import { countLabel } from "../utils/plural";

const UPDATE_BADGE_COLOR: Record<HfUpdateCheckStatus, string> = {
  unchecked: "gray",
  "in-sync": "green",
  drift: "yellow",
  error: "red",
};

export function hfUpdateBadge(repo: HfDownloadedRepo) {
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

export function hfFileLocalBadge(state: HfLocalFileState) {
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
        changed
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

export function hfMissingFilesBadge(repo: HfDownloadedRepo) {
  if (repo.missingFiles === 0) {
    return null;
  }
  return (
    <Badge color="orange" variant="light">
      {countLabel(repo.missingFiles, "missing file")}
    </Badge>
  );
}

export function hfDownloadingBadge(running: boolean) {
  if (!running) {
    return null;
  }
  return (
    <Badge color="blue" variant="light">
      downloading
    </Badge>
  );
}
