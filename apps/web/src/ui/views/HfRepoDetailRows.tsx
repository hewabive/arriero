import type {
  HfDownloadFile,
  HfDownloadedRepo,
  HfDownloadedRepoFile,
  HfGgufVariant,
  HfRepoBrowse,
  HfTreeFile,
} from "@arriero/core";
import { Checkbox, Group, ScrollArea, Stack, Text } from "@mantine/core";

import {
  hfLocalFileState,
  hfLocalVariantState,
  type HfLocalVariantState,
} from "../utils/hf";
import { formatBytes } from "../utils/models";
import { hfFileLocalBadge } from "./HfBadges";
import { HfJobFileRow } from "./HfJobFileRow";

type HfFileRowState =
  | "current"
  | "changed"
  | "absent"
  | "missing"
  | "partial"
  | "local-only";

export type HfFileRow = {
  path: string;
  size: number;
  state: HfFileRowState;
  partialBytes: number;
};

type HfVariantRow = {
  variant: HfGgufVariant;
  state: HfLocalVariantState;
};

export type HfDetailRows = {
  variants: HfVariantRow[];
  files: HfFileRow[];
  localOnly: HfFileRow[];
  downloadable: ReadonlyMap<string, number>;
};

function byPath(a: { path: string }, b: { path: string }) {
  return a.path.localeCompare(b.path);
}

function absentRowState(
  entry: HfDownloadedRepoFile | undefined,
): HfFileRowState {
  if (entry && entry.partialBytes > 0) {
    return "partial";
  }
  return entry ? "missing" : "absent";
}

function remoteRowState(
  file: HfTreeFile,
  localFiles: ReadonlyMap<string, HfDownloadedRepoFile>,
): HfFileRowState {
  const entry = localFiles.get(file.path);
  if (entry && !entry.present) {
    return absentRowState(entry);
  }
  return hfLocalFileState(file, localFiles);
}

export function manifestRows(repo: HfDownloadedRepo): HfDetailRows {
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
        state: file.present ? "current" : absentRowState(file),
        partialBytes: file.partialBytes,
      }),
    )
    .sort(byPath);
  return { variants, files, localOnly: [], downloadable: new Map() };
}

export function browseRows(
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
      files.push({
        path: file.path,
        size: file.size,
        state,
        partialBytes: localFiles.get(file.path)?.partialBytes ?? 0,
      });
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
        partialBytes: 0,
      }),
    )
    .sort(byPath);
  return { variants, files, localOnly, downloadable };
}

export function FileRows(props: {
  rows: HfFileRow[];
  selection: ReadonlySet<string>;
  onToggle: (paths: readonly string[], checked: boolean) => void;
  jobFiles?: ReadonlyMap<string, HfDownloadFile> | undefined;
  onSkipFile?: ((path: string) => void) | undefined;
}) {
  return (
    <ScrollArea.Autosize mah={240} type="auto" offsetScrollbars>
      <Stack gap={2}>
        {props.rows.map((row) => {
          const jobFile = props.jobFiles?.get(row.path);
          if (
            jobFile &&
            (jobFile.status === "downloading" || jobFile.status === "pending")
          ) {
            return (
              <HfJobFileRow
                key={row.path}
                file={jobFile}
                action={
                  props.onSkipFile
                    ? {
                        label: "Skip file",
                        onAction: () => props.onSkipFile?.(row.path),
                      }
                    : undefined
                }
              />
            );
          }
          return (
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
                  {hfFileLocalBadge(row.state, {
                    partialBytes: row.partialBytes,
                    size: row.size,
                  })}
                  <Text size="xs" c="dimmed">
                    {formatBytes(row.size)}
                  </Text>
                </Group>
              }
            />
          );
        })}
      </Stack>
    </ScrollArea.Autosize>
  );
}
