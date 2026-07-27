import type { FileSystemEntry } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Home,
  RefreshCw,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
} from "react";

import { listFilesystemDirectory } from "../../api/client";
import { formatBytes } from "../utils/models";

type PathPickerMode = "file" | "directory";
type PathPickerFilter = "any" | "binary" | "model";

function dirname(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  const slash = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (slash <= 0) {
    return slash === 0 ? normalized.slice(0, 1) : "";
  }
  return normalized.slice(0, slash);
}

function initialDirectory(value: string, mode: PathPickerMode) {
  if (!value.trim()) {
    return undefined;
  }
  return mode === "directory" ? value.trim() : dirname(value.trim());
}

function pathSegments(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const root = normalized.startsWith("/") ? "/" : "";
  const parts = normalized.split("/").filter(Boolean);
  const segments: { label: string; path: string }[] = [];
  let current = root;

  if (root) {
    segments.push({ label: root, path: root });
  }

  for (const part of parts) {
    current =
      current === "/" || current === ""
        ? `${current}${part}`
        : `${current}/${part}`;
    segments.push({ label: part, path: current });
  }

  return segments;
}

function isNonPrimaryGgufShard(name: string) {
  const match = /-(?<index>\d+)-of-(?<count>\d+)\.gguf$/i.exec(name);
  if (!match) {
    return false;
  }

  const index = Number(match.groups?.index);
  const count = Number(match.groups?.count);
  return count > 1 && index > 1 && index <= count;
}

function isSelectableEntry(
  entry: FileSystemEntry,
  mode: PathPickerMode,
  filter: PathPickerFilter,
) {
  if (mode === "directory") {
    return entry.type === "directory";
  }
  if (entry.type !== "file") {
    return false;
  }
  if (filter === "model") {
    return entry.extension === ".gguf" && !isNonPrimaryGgufShard(entry.name);
  }
  if (filter === "binary") {
    return entry.executable;
  }
  return true;
}

function shouldShowEntry(
  entry: FileSystemEntry,
  mode: PathPickerMode,
  filter: PathPickerFilter,
) {
  if (entry.type === "directory") {
    return true;
  }
  return isSelectableEntry(entry, mode, filter);
}

function entrySearchText(entry: FileSystemEntry) {
  return `${entry.name} ${entry.path} ${entry.extension ?? ""}`.toLowerCase();
}

export function PathPickerInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mode: PathPickerMode;
  filter?: PathPickerFilter;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  w?: number | string;
  "aria-label"?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  const filter = props.filter ?? "any";
  const [opened, setOpened] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | undefined>(() =>
    initialDirectory(props.value, props.mode),
  );
  const [pathDraft, setPathDraft] = useState("");
  const [search, setSearch] = useState("");
  const optionalInputProps = {
    ...(props.placeholder ? { placeholder: props.placeholder } : {}),
    ...(props.className ? { className: props.className } : {}),
    ...(props.style ? { style: props.style } : {}),
    ...(props.w ? { w: props.w } : {}),
    ...(props.onKeyDown ? { onKeyDown: props.onKeyDown } : {}),
  };

  const directoryQuery = useQuery({
    queryKey: ["filesystem-list", currentPath],
    queryFn: () => listFilesystemDirectory(currentPath),
    enabled: opened,
    retry: false,
  });
  const directory = directoryQuery.data?.data;
  const segments = useMemo(
    () => pathSegments(directory?.path ?? currentPath ?? ""),
    [currentPath, directory?.path],
  );
  const visibleEntries = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (directory?.entries ?? []).filter((entry) => {
      if (!shouldShowEntry(entry, props.mode, filter)) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      return entrySearchText(entry).includes(normalizedSearch);
    });
  }, [directory?.entries, filter, props.mode, search]);

  useEffect(() => {
    if (!opened) {
      return;
    }
    setCurrentPath(initialDirectory(props.value, props.mode));
    setSearch("");
  }, [opened, props.mode, props.value]);

  useEffect(() => {
    if (directory?.path) {
      setPathDraft(directory.path);
    }
  }, [directory?.path]);

  function selectPath(path: string) {
    props.onChange(path);
    setOpened(false);
  }

  function openEntry(entry: FileSystemEntry) {
    if (entry.type === "directory") {
      setCurrentPath(entry.path);
      return;
    }
    if (isSelectableEntry(entry, props.mode, filter)) {
      selectPath(entry.path);
    }
  }

  function jumpToDraft() {
    if (!pathDraft.trim()) {
      return;
    }
    setCurrentPath(pathDraft.trim());
  }

  return (
    <>
      <TextInput
        aria-label={props["aria-label"] ?? props.label}
        label={props.label}
        value={props.value}
        required={props.required ?? false}
        disabled={props.disabled ?? false}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        {...optionalInputProps}
        rightSection={
          <Tooltip label="Browse filesystem">
            <ActionIcon
              aria-label={`Browse ${props.label}`}
              disabled={props.disabled ?? false}
              size="sm"
              variant="subtle"
              onClick={() => setOpened(true)}
            >
              <FolderOpen size={16} />
            </ActionIcon>
          </Tooltip>
        }
      />

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={`Select ${props.label}`}
        size="xl"
        centered
      >
        <Stack gap="sm">
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <TextInput
              label="Path"
              value={pathDraft}
              onChange={(event) => setPathDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jumpToDraft();
                }
              }}
              style={{ flex: 1 }}
            />
            <Button type="button" variant="light" onClick={jumpToDraft}>
              Open
            </Button>
            <Tooltip label="Refresh">
              <ActionIcon
                aria-label="Refresh directory"
                variant="subtle"
                loading={directoryQuery.isFetching}
                onClick={() => directoryQuery.refetch()}
              >
                <RefreshCw size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>

          {directory?.roots && (
            <Group gap="xs" wrap="wrap">
              {directory.roots.map((root) => (
                <Button
                  key={`${root.label}-${root.path}`}
                  type="button"
                  size="xs"
                  variant="subtle"
                  leftSection={<Home size={14} />}
                  onClick={() => setCurrentPath(root.path)}
                >
                  {root.label}
                </Button>
              ))}
            </Group>
          )}

          <Group gap={4} wrap="wrap">
            {segments.map((segment, index) => (
              <Group key={`${segment.path}-${index}`} gap={4}>
                {index > 0 && <ChevronRight size={14} />}
                <Button
                  type="button"
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setCurrentPath(segment.path)}
                >
                  {segment.label}
                </Button>
              </Group>
            ))}
          </Group>

          <Group justify="space-between" align="flex-end" wrap="wrap">
            <TextInput
              label="Search"
              placeholder="file or directory"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                }
              }}
              className="search-input"
            />
            <Group gap="xs">
              <Badge variant="light">{visibleEntries.length} entries</Badge>
              {props.mode === "directory" && directory?.path && (
                <Button
                  type="button"
                  leftSection={<Check size={16} />}
                  onClick={() => selectPath(directory.path)}
                >
                  Use directory
                </Button>
              )}
            </Group>
          </Group>

          {directoryQuery.isError && (
            <Text c="red" size="sm">
              {(directoryQuery.error as Error).message}
            </Text>
          )}

          <ScrollArea h={380} type="auto" offsetScrollbars>
            <Stack gap="xs">
              {directory?.parentPath && (
                <Paper
                  withBorder
                  p="xs"
                  radius="sm"
                  className="path-picker-row"
                  onClick={() =>
                    setCurrentPath(directory.parentPath ?? undefined)
                  }
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap" className="path-picker-name">
                      <Folder size={16} />
                      <Text fw={600}>..</Text>
                    </Group>
                    <Text c="dimmed" size="xs">
                      Parent
                    </Text>
                  </Group>
                </Paper>
              )}

              {visibleEntries.map((entry) => {
                const selectable = isSelectableEntry(entry, props.mode, filter);
                return (
                  <Paper
                    key={entry.path}
                    withBorder
                    p="xs"
                    radius="sm"
                    className="path-picker-row"
                    onClick={() => openEntry(entry)}
                  >
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Group
                        gap="xs"
                        wrap="nowrap"
                        className="path-picker-name"
                      >
                        {entry.type === "directory" ? (
                          <Folder size={16} />
                        ) : (
                          <File size={16} />
                        )}
                        <Stack gap={2} className="path-picker-name">
                          <Text fw={600} size="sm" lineClamp={1}>
                            {entry.name}
                          </Text>
                          <Code className="code-wrap">{entry.path}</Code>
                        </Stack>
                      </Group>
                      <Group gap="xs" wrap="nowrap">
                        {entry.type === "directory" ? (
                          <Badge variant="light">dir</Badge>
                        ) : (
                          <>
                            {entry.executable && (
                              <Badge color="green" variant="light">
                                exec
                              </Badge>
                            )}
                            {entry.sizeBytes !== null && (
                              <Badge variant="outline">
                                {formatBytes(entry.sizeBytes)}
                              </Badge>
                            )}
                          </>
                        )}
                        {selectable && entry.type !== "directory" && (
                          <Button
                            type="button"
                            size="xs"
                            variant="light"
                            onClick={(event) => {
                              event.stopPropagation();
                              selectPath(entry.path);
                            }}
                          >
                            Select
                          </Button>
                        )}
                      </Group>
                    </Group>
                  </Paper>
                );
              })}

              {!directoryQuery.isFetching && visibleEntries.length === 0 && (
                <Paper withBorder p="md" radius="sm">
                  <Text c="dimmed" ta="center">
                    No matching entries
                  </Text>
                </Paper>
              )}
            </Stack>
          </ScrollArea>
        </Stack>
      </Modal>
    </>
  );
}
