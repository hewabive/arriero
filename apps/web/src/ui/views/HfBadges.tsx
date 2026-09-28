import {
  GGUF_ARTIFACT_KIND_LABEL,
  isDraftGgufArtifactKind,
  type HfGgufVariant,
} from "@arriero/core";
import { Anchor, Badge } from "@mantine/core";
import type { HfLocalFileState, HfLocalVariantState } from "../utils/hf";

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
        changed upstream
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
  if (variant.kind === "model" || variant.kind === "other") {
    return null;
  }
  const label = GGUF_ARTIFACT_KIND_LABEL[variant.kind];
  return (
    <Badge color="grape" variant="light">
      {isDraftGgufArtifactKind(variant.kind) ? `${label} draft` : label}
    </Badge>
  );
}

export function HfRepoLink({ repoId }: { repoId: string }) {
  return (
    <Anchor
      href={`https://huggingface.co/${repoId}`}
      target="_blank"
      rel="noreferrer"
      fw={600}
      className="text-wrap"
    >
      {repoId}
    </Anchor>
  );
}
