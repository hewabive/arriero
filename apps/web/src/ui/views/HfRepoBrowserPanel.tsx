import {
  parseHfRepoInput,
  type HfGgufVariant,
  type HfRepoBrowse,
  type HfTreeFile,
} from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  browseHfRepo,
  getHfDestCheck,
  startHfDownload,
} from "../../api/client";
import { PathPickerInput } from "../components/PathPickerInput";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";

function variantTitle(variant: HfGgufVariant): string {
  if (variant.label) {
    return variant.label;
  }
  const first = variant.paths[0] ?? "";
  return first.split("/").at(-1) ?? first;
}

function variantKindBadge(variant: HfGgufVariant) {
  if (variant.kind === "mmproj") {
    return (
      <Badge color="grape" variant="light">
        mmproj
      </Badge>
    );
  }
  return null;
}

type DirGroup = { dir: string; files: HfTreeFile[]; totalBytes: number };

export function HfRepoBrowserPanel() {
  const queryClient = useQueryClient();
  const [repoInput, setRepoInput] = useState("");
  const [revisionInput, setRevisionInput] = useState("");
  const [submitted, setSubmitted] = useState<{
    repo: string;
    revision: string;
  } | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [destDir, setDestDir] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [allFilesOpened, setAllFilesOpened] = useState(false);

  const browseQuery = useQuery({
    queryKey: ["hf-browse", submitted?.repo ?? "", submitted?.revision ?? ""],
    queryFn: () =>
      browseHfRepo(submitted?.repo ?? "", submitted?.revision || undefined),
    enabled: submitted !== null,
    retry: false,
    staleTime: 60_000,
  });
  const browse: HfRepoBrowse | null = browseQuery.data?.data ?? null;
  const browseKey = browse ? `${browse.repoId}@${browse.commitSha}` : "";

  useEffect(() => {
    setSelection(new Set());
    setExpandedDirs(new Set());
    setAllFilesOpened(browse !== null && browse.ggufVariants === null);
  }, [browseKey, browse === null]);

  const sizeByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of browse?.files ?? []) {
      map.set(file.path, file.size);
    }
    return map;
  }, [browse]);

  const dirGroups = useMemo((): DirGroup[] => {
    const map = new Map<string, HfTreeFile[]>();
    for (const file of browse?.files ?? []) {
      const slash = file.path.lastIndexOf("/");
      const dir = slash === -1 ? "" : file.path.slice(0, slash);
      const list = map.get(dir) ?? [];
      list.push(file);
      map.set(dir, list);
    }
    return [...map.entries()]
      .map(([dir, files]) => ({
        dir,
        files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }, [browse]);

  const destQuery = useQuery({
    queryKey: ["hf-dest-check", browse?.repoId ?? "", destDir.trim()],
    queryFn: () =>
      getHfDestCheck(
        destDir.trim()
          ? { dir: destDir.trim() }
          : { repo: browse?.repoId ?? "" },
      ),
    enabled: browse !== null,
  });
  const destCheck = destQuery.data?.data ?? null;

  const startMutation = useMutation({
    mutationFn: () =>
      startHfDownload({
        repoId: browse?.repoId ?? "",
        revision: browse?.commitSha ?? "main",
        paths: [...selection],
        ...(destDir.trim() ? { destDir: destDir.trim() } : {}),
      }),
    onSuccess: (result) => {
      setSelection(new Set());
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

  function submitBrowse() {
    const parsed = parseHfRepoInput(repoInput);
    if (!parsed) {
      notifications.show({
        color: "red",
        title: "HuggingFace repo",
        message: "Enter a repo id like owner/repo or a huggingface.co URL.",
      });
      return;
    }
    const revision = revisionInput.trim() || parsed.revision || "";
    setRepoInput(parsed.repoId);
    if (!revisionInput.trim() && parsed.revision) {
      setRevisionInput(parsed.revision);
    }
    setSubmitted({ repo: parsed.repoId, revision });
  }

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

  function toggleDir(dir: string) {
    setExpandedDirs((previous) => {
      const next = new Set(previous);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  }

  const selectedBytes = [...selection].reduce(
    (sum, path) => sum + (sizeByPath.get(path) ?? 0),
    0,
  );
  const freeBytes = destCheck?.freeBytes ?? null;
  const notEnoughSpace = freeBytes !== null && selectedBytes > freeBytes;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Title order={4}>Repository browser</Title>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitBrowse();
          }}
        >
          <Group align="flex-end" gap="sm" wrap="wrap">
            <TextInput
              label="Repository"
              placeholder="owner/repo or huggingface.co URL"
              value={repoInput}
              onChange={(event) => setRepoInput(event.currentTarget.value)}
              w={340}
            />
            <TextInput
              label="Revision"
              placeholder="main"
              value={revisionInput}
              onChange={(event) => setRevisionInput(event.currentTarget.value)}
              w={160}
            />
            <Button
              type="submit"
              leftSection={<Search size={14} />}
              loading={browseQuery.isFetching}
              disabled={repoInput.trim().length === 0}
            >
              Browse
            </Button>
          </Group>
        </form>

        {browseQuery.isError && (
          <Alert color="red" title="Browse failed">
            {(browseQuery.error as Error).message}
          </Alert>
        )}

        {browse && (
          <Stack gap="sm">
            <Group gap="xs" wrap="wrap">
              <Code>{browse.repoId}</Code>
              <Badge color="gray" variant="outline">
                {browse.commitSha.slice(0, 10)}
              </Badge>
              {browse.gated && (
                <Badge color="orange" variant="light">
                  gated
                </Badge>
              )}
              {browse.private && (
                <Badge color="orange" variant="light">
                  private
                </Badge>
              )}
              <Text size="sm" c="dimmed">
                {countLabel(browse.files.length, "file")}
              </Text>
              {browse.truncated && (
                <Badge color="yellow" variant="light">
                  listing truncated
                </Badge>
              )}
            </Group>

            {browse.ggufVariants && browse.ggufVariants.length > 0 && (
              <Stack gap={6}>
                <Text fw={600} size="sm">
                  GGUF variants
                </Text>
                <ScrollArea.Autosize mah={320} type="auto" offsetScrollbars>
                  <Stack gap={4}>
                    {browse.ggufVariants.map((variant) => {
                      const checked = variant.paths.every((path) =>
                        selection.has(path),
                      );
                      const indeterminate =
                        !checked &&
                        variant.paths.some((path) => selection.has(path));
                      return (
                        <Checkbox
                          key={variant.paths[0]}
                          checked={checked}
                          indeterminate={indeterminate}
                          onChange={(event) =>
                            togglePaths(
                              variant.paths,
                              event.currentTarget.checked,
                            )
                          }
                          label={
                            <Group gap="xs" wrap="wrap">
                              <Text size="sm" fw={500}>
                                {variantTitle(variant)}
                              </Text>
                              {variantKindBadge(variant)}
                              {variant.splitCount !== null && (
                                <Badge color="gray" variant="outline">
                                  {countLabel(variant.paths.length, "shard")}
                                </Badge>
                              )}
                              {!variant.complete && (
                                <Badge color="red" variant="light">
                                  incomplete split
                                </Badge>
                              )}
                              <Text size="sm" c="dimmed">
                                {formatBytes(variant.totalBytes)}
                              </Text>
                            </Group>
                          }
                        />
                      );
                    })}
                  </Stack>
                </ScrollArea.Autosize>
              </Stack>
            )}

            <Stack gap={6}>
              <Group gap={4}>
                <Button
                  variant="subtle"
                  size="compact-sm"
                  leftSection={
                    allFilesOpened ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )
                  }
                  onClick={() => setAllFilesOpened((value) => !value)}
                >
                  All files
                </Button>
                <Button
                  variant="subtle"
                  size="compact-sm"
                  onClick={() =>
                    togglePaths(
                      browse.files.map((file) => file.path),
                      true,
                    )
                  }
                >
                  Select all
                </Button>
                <Button
                  variant="subtle"
                  size="compact-sm"
                  onClick={() => setSelection(new Set())}
                  disabled={selection.size === 0}
                >
                  Clear
                </Button>
              </Group>
              <Collapse in={allFilesOpened}>
                <ScrollArea.Autosize mah={360} type="auto" offsetScrollbars>
                  <Stack gap={2}>
                    {dirGroups.map((group) => {
                      const paths = group.files.map((file) => file.path);
                      const checked = paths.every((path) =>
                        selection.has(path),
                      );
                      const indeterminate =
                        !checked && paths.some((path) => selection.has(path));
                      const expanded =
                        expandedDirs.has(group.dir) || group.dir === "";
                      return (
                        <Stack key={group.dir || "(root)"} gap={2}>
                          {group.dir !== "" && (
                            <Group gap={6} wrap="nowrap">
                              <Checkbox
                                checked={checked}
                                indeterminate={indeterminate}
                                onChange={(event) =>
                                  togglePaths(
                                    paths,
                                    event.currentTarget.checked,
                                  )
                                }
                              />
                              <Button
                                variant="subtle"
                                size="compact-sm"
                                color="gray"
                                leftSection={
                                  expanded ? (
                                    <ChevronDown size={14} />
                                  ) : (
                                    <ChevronRight size={14} />
                                  )
                                }
                                onClick={() => toggleDir(group.dir)}
                              >
                                {group.dir}/
                              </Button>
                              <Text size="xs" c="dimmed">
                                {countLabel(group.files.length, "file")} ·{" "}
                                {formatBytes(group.totalBytes)}
                              </Text>
                            </Group>
                          )}
                          <Collapse in={expanded}>
                            <Stack gap={2} pl={group.dir === "" ? 0 : 28}>
                              {group.files.map((file) => (
                                <Checkbox
                                  key={file.path}
                                  checked={selection.has(file.path)}
                                  onChange={(event) =>
                                    togglePaths(
                                      [file.path],
                                      event.currentTarget.checked,
                                    )
                                  }
                                  label={
                                    <Group gap="xs" wrap="nowrap">
                                      <Text
                                        size="sm"
                                        style={{
                                          overflowWrap: "anywhere",
                                        }}
                                      >
                                        {file.path.split("/").at(-1)}
                                      </Text>
                                      <Text size="xs" c="dimmed">
                                        {formatBytes(file.size)}
                                      </Text>
                                    </Group>
                                  }
                                />
                              ))}
                            </Stack>
                          </Collapse>
                        </Stack>
                      );
                    })}
                  </Stack>
                </ScrollArea.Autosize>
              </Collapse>
            </Stack>

            <Group align="flex-end" gap="sm" wrap="wrap">
              <PathPickerInput
                label="Destination"
                mode="directory"
                value={destDir}
                onChange={setDestDir}
                placeholder={destCheck?.dir ?? "models directory"}
                w={380}
              />
              <Button
                leftSection={<Download size={14} />}
                onClick={() => startMutation.mutate()}
                loading={startMutation.isPending}
                disabled={selection.size === 0 || notEnoughSpace}
              >
                Download
              </Button>
            </Group>
            <Group gap="xs" wrap="wrap">
              <Text size="sm" c={notEnoughSpace ? "red" : "dimmed"}>
                Selected {countLabel(selection.size, "file")} ·{" "}
                {formatBytes(selectedBytes)}
                {freeBytes !== null ? ` · free ${formatBytes(freeBytes)}` : ""}
              </Text>
              {destCheck && !destCheck.insideScanRoots && (
                <Text size="sm" c="orange">
                  Outside the model scan roots — the download will not appear in
                  the list below.
                </Text>
              )}
            </Group>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
