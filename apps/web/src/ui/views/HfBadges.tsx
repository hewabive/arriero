import type { HfGgufVariant } from "@arriero/core";
import { Badge } from "@mantine/core";
import type { HfLocalFileState, HfLocalVariantState } from "../utils/hf";
import { formatBytes } from "../utils/models";

export function hfFileLocalBadge(
  state: HfLocalFileState | "missing" | "partial" | "local-only",
  partial?: { partialBytes: number; size: number } | undefined,
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
  if (state === "partial") {
    return (
      <Badge color="orange" variant="light">
        {partial
          ? `${formatBytes(partial.partialBytes)} of ${formatBytes(partial.size)}`
          : "partial"}
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
  const labels: Partial<Record<HfGgufVariant["kind"], string>> = {
    mmproj: "mmproj",
    "draft-mtp": "MTP draft",
    "draft-eagle3": "EAGLE3 draft",
    "draft-dflash": "DFlash draft",
    "draft-dspark": "DSpark draft",
    imatrix: "imatrix",
  };
  const label = labels[variant.kind];
  if (label) {
    return (
      <Badge color="grape" variant="light">
        {label}
      </Badge>
    );
  }
  return null;
}
