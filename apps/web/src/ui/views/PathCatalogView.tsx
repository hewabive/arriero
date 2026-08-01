import {
  INSTANCE_KINDS,
  engineDescriptor,
  type Instance,
  type InstanceKind,
  type PathCatalogEntry,
  type PathCatalogKind,
  type PathCatalogUpdate,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Folder, Pencil, Plus, Save, Server, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  createPathCatalogEntry,
  deletePathCatalogEntry,
  listInstances,
  listPathCatalog,
  updatePathCatalogEntry,
} from "../../api/client";
import { PathPickerInput } from "../components/PathPickerInput";
import { pathBaseName } from "../utils/models";
import { formatLocalDateTime } from "../utils/time";
import { countLabel } from "../utils/plural";

type Draft = {
  name: string;
  path: string;
  engineKind: InstanceKind | null;
};

type EditorState =
  | { mode: "create"; kind: PathCatalogKind; entry: null }
  | { mode: "edit"; kind: PathCatalogKind; entry: PathCatalogEntry };

type KindFilter = PathCatalogKind | "all";

const emptyDraft: Draft = { name: "", path: "", engineKind: null };
const pathKinds: PathCatalogKind[] = ["binary", "models-dir"];
const engineKindOptions = INSTANCE_KINDS.map((kind) => ({
  value: kind,
  label: `${engineDescriptor(kind).displayName} (${kind})`,
}));

function kindTitle(kind: PathCatalogKind) {
  return kind === "binary" ? "Binary paths" : "Model directories";
}

function kindLabel(kind: PathCatalogKind) {
  return kind === "binary" ? "binary" : "models dir";
}

function kindColor(kind: PathCatalogKind) {
  return kind === "binary" ? "blue" : "teal";
}

function kindIcon(kind: PathCatalogKind) {
  return kind === "binary" ? <Server size={18} /> : <Folder size={18} />;
}

function entryMatchesSearch(
  entry: PathCatalogEntry,
  usage: Instance[],
  search: string,
) {
  const normalized = search.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    entry.name,
    entry.path,
    pathBaseName(entry.path),
    entry.kind,
    ...usage.map((instance) => instance.name),
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

export function PathCatalogView() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const catalogQuery = useQuery({
    queryKey: ["path-catalog"],
    queryFn: () => listPathCatalog(),
    staleTime: 30_000,
  });
  const instancesQuery = useQuery({
    queryKey: ["instances"],
    queryFn: listInstances,
    staleTime: 10_000,
  });

  const entries = catalogQuery.data?.data ?? [];
  const instances = instancesQuery.data?.data ?? [];
  const usageByEntry = useMemo(() => {
    const map = new Map<string, Instance[]>();
    for (const entry of entries) {
      map.set(
        entry.id,
        instances.filter((instance) => instance.binaryPathRefId === entry.id),
      );
    }
    return map;
  }, [entries, instances]);
  const counts = useMemo(
    () => ({
      binary: entries.filter((entry) => entry.kind === "binary").length,
      modelsDir: entries.filter((entry) => entry.kind === "models-dir").length,
      linked: entries.filter(
        (entry) => (usageByEntry.get(entry.id) ?? []).length > 0,
      ).length,
    }),
    [entries, usageByEntry],
  );
  const filteredEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (kindFilter !== "all" && entry.kind !== kindFilter) {
          return false;
        }
        return entryMatchesSearch(
          entry,
          usageByEntry.get(entry.id) ?? [],
          search,
        );
      }),
    [entries, kindFilter, search, usageByEntry],
  );
  const entriesByKind = useMemo(
    () => ({
      binary: filteredEntries.filter((entry) => entry.kind === "binary"),
      "models-dir": filteredEntries.filter(
        (entry) => entry.kind === "models-dir",
      ),
    }),
    [filteredEntries],
  );

  async function invalidateCatalog() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["path-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["instances"] }),
      queryClient.invalidateQueries({ queryKey: ["instances-health-summary"] }),
      queryClient.invalidateQueries({
        queryKey: ["instance-preflight-preview"],
      }),
    ]);
  }

  function closeEditor() {
    setEditor(null);
    setDraft(emptyDraft);
  }

  const createMutation = useMutation({
    mutationFn: createPathCatalogEntry,
    onSuccess: async (result) => {
      closeEditor();
      await invalidateCatalog();
      notifications.show({
        title: "Path catalog entry created",
        message: result.data.name,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Path catalog create failed",
        message: (error as Error).message,
      }),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; draft: PathCatalogUpdate }) =>
      updatePathCatalogEntry(input.id, input.draft),
    onSuccess: async (result) => {
      closeEditor();
      await invalidateCatalog();
      notifications.show({
        title: "Path catalog entry saved",
        message: result.data.name,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Path catalog save failed",
        message: (error as Error).message,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: deletePathCatalogEntry,
    onSuccess: async () => {
      await invalidateCatalog();
      notifications.show({
        title: "Path catalog entry deleted",
        message: "Entry removed",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Path catalog delete failed",
        message: (error as Error).message,
      }),
  });

  function openCreate(kind: PathCatalogKind) {
    setDraft(emptyDraft);
    setEditor({ mode: "create", kind, entry: null });
  }

  function openEdit(entry: PathCatalogEntry) {
    setDraft({
      name: entry.name,
      path: entry.path,
      engineKind: entry.engineKind ?? null,
    });
    setEditor({ mode: "edit", kind: entry.kind, entry });
  }

  function saveEditor() {
    if (!editor) {
      return;
    }
    const name = draft.name.trim();
    const path = draft.path.trim();
    if (editor.mode === "create") {
      createMutation.mutate({
        kind: editor.kind,
        name,
        path,
        ...(editor.kind === "binary" && draft.engineKind
          ? { engineKind: draft.engineKind }
          : {}),
      });
      return;
    }
    updateMutation.mutate({
      id: editor.entry.id,
      draft: {
        name,
        path,
        ...(editor.kind === "binary" ? { engineKind: draft.engineKind } : {}),
      },
    });
  }

  function copyPath(entry: PathCatalogEntry) {
    navigator.clipboard
      .writeText(entry.path)
      .then(() =>
        notifications.show({
          title: "Path copied",
          message: entry.name,
        }),
      )
      .catch((error: unknown) =>
        notifications.show({
          color: "red",
          title: "Copy failed",
          message: (error as Error).message,
        }),
      );
  }

  function renderEntry(entry: PathCatalogEntry) {
    const usage = usageByEntry.get(entry.id) ?? [];
    const deleteDisabled = usage.length > 0;

    return (
      <Paper
        key={entry.id}
        withBorder
        p="sm"
        radius="sm"
        className="path-catalog-entry"
      >
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group
            gap="sm"
            align="flex-start"
            wrap="nowrap"
            className="path-catalog-entry-main"
          >
            <ThemeIcon
              color={kindColor(entry.kind)}
              variant="light"
              radius="sm"
              size={34}
            >
              {kindIcon(entry.kind)}
            </ThemeIcon>
            <Stack gap={4} className="path-catalog-entry-body">
              <Group gap="xs" wrap="wrap">
                <Text fw={650}>{entry.name}</Text>
                <Badge color={kindColor(entry.kind)} variant="light">
                  {kindLabel(entry.kind)}
                </Badge>
                {entry.engineKind && (
                  <Badge color="grape" variant="outline">
                    {entry.engineKind}
                  </Badge>
                )}
                <Badge variant={usage.length > 0 ? "light" : "outline"}>
                  {usage.length} used
                </Badge>
              </Group>
              <Group gap="xs" wrap="wrap">
                <Code className="path-catalog-basename">
                  {pathBaseName(entry.path)}
                </Code>
                <Text c="dimmed" size="xs">
                  Updated {formatLocalDateTime(entry.updatedAt)}
                </Text>
              </Group>
              <Code className="code-wrap path-catalog-path">{entry.path}</Code>
              {usage.length > 0 && (
                <Group gap={6} wrap="wrap">
                  <Text c="dimmed" size="xs">
                    Instances
                  </Text>
                  {usage.map((instance) => (
                    <Badge key={instance.name} variant="outline" color="gray">
                      {instance.name}
                    </Badge>
                  ))}
                </Group>
              )}
            </Stack>
          </Group>
          <Group gap="xs" wrap="nowrap" className="path-catalog-entry-actions">
            <Tooltip label="Copy path">
              <ActionIcon
                aria-label={`Copy ${entry.name} path`}
                variant="subtle"
                onClick={() => copyPath(entry)}
              >
                <Copy size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Edit">
              <ActionIcon
                aria-label={`Edit ${entry.name}`}
                variant="light"
                onClick={() => openEdit(entry)}
              >
                <Pencil size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip
              label={
                deleteDisabled ? "Used entries cannot be deleted" : "Delete"
              }
            >
              <ActionIcon
                aria-label={`Delete ${entry.name}`}
                color="red"
                variant="subtle"
                loading={deleteMutation.isPending}
                disabled={deleteDisabled}
                onClick={() => deleteMutation.mutate(entry.id)}
              >
                <Trash2 size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </Paper>
    );
  }

  function renderKind(kind: PathCatalogKind) {
    const kindEntries = entriesByKind[kind];

    return (
      <Stack key={kind} gap="xs">
        <Group gap="xs" wrap="wrap">
          <Title order={3}>{kindTitle(kind)}</Title>
          <Badge variant="light">{kindEntries.length}</Badge>
        </Group>

        {kindEntries.length > 0 ? (
          <Stack gap="xs">{kindEntries.map(renderEntry)}</Stack>
        ) : (
          <Paper withBorder p="lg" radius="sm">
            <Text c="dimmed" ta="center">
              {catalogQuery.isFetching
                ? "Loading catalog..."
                : `No ${kindLabel(kind)} paths found`}
            </Text>
          </Paper>
        )}
      </Stack>
    );
  }

  const visibleKinds =
    kindFilter === "all"
      ? pathKinds
      : pathKinds.filter((kind) => kind === kindFilter);
  const editorBusy = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="xs" wrap="wrap">
            <Badge variant="light">
              {countLabel(counts.binary, "binary", "binaries")}
            </Badge>
            <Badge variant="light" color="teal">
              {countLabel(counts.modelsDir, "model dir")}
            </Badge>
            <Badge variant="outline">{counts.linked} linked</Badge>
          </Group>
          <Group gap="xs" wrap="wrap">
            <Button
              variant="light"
              leftSection={<Plus size={16} />}
              onClick={() => openCreate("binary")}
            >
              Add binary
            </Button>
            <Button
              variant="light"
              color="teal"
              leftSection={<Plus size={16} />}
              onClick={() => openCreate("models-dir")}
            >
              Add model directory
            </Button>
          </Group>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="sm">
        <Group align="flex-end" gap="xs" wrap="wrap">
          <TextInput
            label="Search"
            placeholder="name, path, instance"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            className="search-input"
          />
          <SegmentedControl
            value={kindFilter}
            onChange={(value) => setKindFilter(value as KindFilter)}
            data={[
              { value: "all", label: "All" },
              { value: "binary", label: "Binary" },
              { value: "models-dir", label: "Model dirs" },
            ]}
          />
        </Group>
      </Paper>

      <Stack gap="lg">{visibleKinds.map(renderKind)}</Stack>

      <Modal
        opened={Boolean(editor)}
        onClose={closeEditor}
        title={
          editor?.mode === "edit"
            ? `Edit ${editor.entry.name}`
            : `Add ${editor ? kindLabel(editor.kind) : "path"}`
        }
        size="lg"
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={draft.name}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({
                ...current,
                name: value,
              }));
            }}
          />
          <PathPickerInput
            label="Path"
            mode={editor?.kind === "models-dir" ? "directory" : "file"}
            filter={editor?.kind === "binary" ? "binary" : "any"}
            value={draft.path}
            onChange={(path) =>
              setDraft((current) => ({
                ...current,
                path,
              }))
            }
          />
          {editor?.kind === "binary" && (
            <Select
              label="Engine"
              description="Instance kind this binary launches; empty = inferred from the file name"
              placeholder="auto (by file name)"
              clearable
              data={engineKindOptions}
              value={draft.engineKind}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  engineKind: (value as InstanceKind | null) ?? null,
                }))
              }
            />
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" onClick={closeEditor}>
              Cancel
            </Button>
            <Button
              leftSection={<Save size={16} />}
              loading={editorBusy}
              disabled={!draft.name.trim() || !draft.path.trim()}
              onClick={saveEditor}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
