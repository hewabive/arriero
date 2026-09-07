import {
  ActionIcon,
  Checkbox,
  Group,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Info,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  libraryFileTree,
  type LibraryFile,
  type LibraryFolder,
} from "../utils/model-library-files";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";

export function ModelLibraryTree(props: {
  files: LibraryFile[];
  selection: ReadonlySet<string>;
  onToggle: (paths: string[], checked: boolean) => void;
  disabled: boolean;
  reveal: boolean;
  onInspect: (path: string) => void;
}) {
  const tree = useMemo(() => libraryFileTree(props.files), [props.files]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);
  function folderRows(folder: LibraryFolder, depth: number) {
    const paths = folder.descendants.map((file) => file.path);
    const selected = paths.filter((path) => props.selection.has(path)).length;
    const open = props.reveal || allExpanded || expanded.has(folder.path);
    const present = folder.descendants.filter((file) => file.present).length;
    const changes = folder.descendants.filter((file) => file.change).length;
    const bytesKnown = folder.descendants.every((file) => file.size !== null);
    return (
      <div key={folder.path} role="group" aria-label={folder.path}>
        <div className="library-tree-row library-tree-folder">
          <div
            className="library-tree-name"
            style={{ paddingLeft: depth * 18 }}
          >
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={`${open ? "Collapse" : "Expand"} ${folder.path}`}
              aria-expanded={open}
              disabled={props.reveal}
              onClick={() => {
                const next = new Set(
                  allExpanded ? collectFolders(tree) : expanded,
                );
                if (open) next.delete(folder.path);
                else next.add(folder.path);
                setAllExpanded(false);
                setExpanded(next);
              }}
            >
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </ActionIcon>
            <Checkbox
              aria-label={`Select folder ${folder.path}`}
              checked={selected === paths.length}
              indeterminate={selected > 0 && selected < paths.length}
              disabled={props.disabled}
              onChange={(event) =>
                props.onToggle(paths, event.currentTarget.checked)
              }
            />
            <Folder size={16} style={{ flexShrink: 0 }} />
            <Text size="sm" fw={600} className="text-wrap">
              {folder.name}/
            </Text>
          </div>
          <Text className="library-tree-size" size="xs" c="dimmed">
            {bytesKnown
              ? formatBytes(
                  folder.descendants.reduce((sum, file) => sum + file.size!, 0),
                )
              : "—"}
          </Text>
          <Text className="library-tree-local" size="xs" c="dimmed">
            {present} of {paths.length} on disk
          </Text>
          <Text
            className={`library-tree-change${changes ? "" : " library-tree-no-change"}`}
            size="xs"
            c={changes ? "orange" : "dimmed"}
          >
            {changes ? countLabel(changes, "change") : "—"}
          </Text>
          <span />
        </div>
        {open && children(folder, depth + 1)}
      </div>
    );
  }
  function children(folder: LibraryFolder, depth: number) {
    return (
      <>
        {folder.folders.map((child) => folderRows(child, depth))}
        {folder.files.map((file) => (
          <div className="library-tree-row" key={file.path}>
            <div
              className="library-tree-name"
              style={{ paddingLeft: depth * 18 + 24 }}
            >
              <Checkbox
                aria-label={`Select file ${file.path}`}
                checked={props.selection.has(file.path)}
                disabled={props.disabled}
                onChange={(event) =>
                  props.onToggle([file.path], event.currentTarget.checked)
                }
              />
              {file.saved ? (
                <Tooltip label="In saved installation">
                  <Bookmark
                    size={15}
                    aria-label="Saved"
                    style={{ flexShrink: 0 }}
                  />
                </Tooltip>
              ) : (
                <File size={15} style={{ flexShrink: 0, opacity: 0.4 }} />
              )}
              <UnstyledButton
                onClick={() => props.onInspect(file.path)}
                className="library-tree-filename"
              >
                {file.path.split("/").at(-1)}
              </UnstyledButton>
            </div>
            <Text className="library-tree-size" size="xs" c="dimmed">
              {file.size === null ? "—" : formatBytes(file.size)}
            </Text>
            <Text
              className="library-tree-local"
              size="xs"
              c={
                file.issue
                  ? "red"
                  : file.state === "Different version"
                    ? "orange"
                    : file.transfer?.status === "downloading"
                      ? "blue"
                      : "dimmed"
              }
            >
              {file.state}
              {file.state === "Partial" &&
                ` · ${formatBytes(file.partialBytes)}`}
              {file.transfer?.status === "downloading" &&
                ` · ${Math.round((100 * file.transfer.downloadedBytes) / Math.max(file.transfer.size, 1))}%`}
            </Text>
            <Text
              className={`library-tree-change${file.change ? "" : " library-tree-no-change"}`}
              size="xs"
              c={
                file.change === "added"
                  ? "teal"
                  : file.change === "deleted"
                    ? "red"
                    : file.change
                      ? "orange"
                      : "dimmed"
              }
            >
              {file.change === "added"
                ? "Added"
                : file.change === "updated"
                  ? "Updated"
                  : file.change === "deleted"
                    ? "Deleted"
                    : "—"}
            </Text>
            <ActionIcon
              className="library-tree-info"
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={`Details for ${file.path}`}
              onClick={() => props.onInspect(file.path)}
            >
              <Info size={14} />
            </ActionIcon>
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      <Group gap="xs" mb={4}>
        <UnstyledButton
          onClick={() => {
            setAllExpanded(true);
            setExpanded(new Set());
          }}
        >
          <Text size="xs" c="dimmed">
            Expand all
          </Text>
        </UnstyledButton>
        <UnstyledButton
          disabled={props.reveal}
          onClick={() => {
            setAllExpanded(false);
            setExpanded(new Set());
          }}
        >
          <Text size="xs" c="dimmed">
            Collapse all
          </Text>
        </UnstyledButton>
        {props.reveal && (
          <Text size="xs" c="dimmed">
            Folder selection applies to matching files.
          </Text>
        )}
      </Group>
      <div className="library-tree" aria-label="Repository files">
        <div className="library-tree-row library-tree-heading">
          <Text size="xs">File</Text>
          <Text size="xs">Size</Text>
          <Text size="xs">On disk</Text>
          <Text size="xs">Since review</Text>
          <span />
        </div>
        {children(tree, 0)}
        {!props.files.length && (
          <Text size="sm" c="dimmed" p="md">
            No files match these filters.
          </Text>
        )}
      </div>
    </>
  );
}

function collectFolders(folder: LibraryFolder): string[] {
  return folder.folders.flatMap((child) => [
    child.path,
    ...collectFolders(child),
  ]);
}
