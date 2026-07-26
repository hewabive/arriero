import type {
  FleetNodeCreate,
  FleetNodeUpdate,
  FleetNodeView,
  FleetSystemEntry,
} from "@llama-manager/core";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  createNode,
  deleteNode,
  getFleetSystem,
  listNodes,
  updateNode,
} from "../../api/client";

type Draft = {
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
  clearToken: boolean;
};

type Editor = { mode: "create" } | { mode: "edit"; node: FleetNodeView };

const emptyDraft: Draft = {
  name: "",
  baseUrl: "",
  token: "",
  enabled: true,
  clearToken: false,
};

function reachability(
  node: FleetNodeView,
  entry: FleetSystemEntry | undefined,
): { color: string; label: string; tooltip: string | null } {
  if (!node.enabled) {
    return { color: "gray", label: "disabled", tooltip: null };
  }
  if (!entry) {
    return { color: "yellow", label: "checking", tooltip: null };
  }
  if (entry.ok) {
    return { color: "green", label: "reachable", tooltip: null };
  }
  return { color: "red", label: "unreachable", tooltip: entry.error };
}

export function NodesView() {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: listNodes,
    staleTime: 10_000,
  });
  const fleetQuery = useQuery({
    queryKey: ["fleet-system"],
    queryFn: getFleetSystem,
    refetchInterval: 10_000,
  });

  const nodes = nodesQuery.data?.data ?? [];
  const fleetByNodeId = useMemo(
    () =>
      new Map(
        (fleetQuery.data?.data ?? []).map((entry) => [entry.nodeId, entry]),
      ),
    [fleetQuery.data?.data],
  );

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    await queryClient.invalidateQueries({ queryKey: ["fleet-system"] });
  }

  function reportError(title: string, error: unknown) {
    notifications.show({
      color: "red",
      title,
      message: (error as Error).message,
    });
  }

  const createMutation = useMutation({
    mutationFn: (input: FleetNodeCreate) => createNode(input),
    onSuccess: async (result) => {
      setEditor(null);
      await invalidate();
      notifications.show({ title: "Node added", message: result.data.name });
    },
    onError: (error) => reportError("Add node failed", error),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; patch: FleetNodeUpdate }) =>
      updateNode(input.id, input.patch),
    onSuccess: async (result) => {
      setEditor(null);
      await invalidate();
      notifications.show({ title: "Node updated", message: result.data.name });
    },
    onError: (error) => reportError("Update node failed", error),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNode(id),
    onSuccess: async () => {
      await invalidate();
      notifications.show({ title: "Node removed", message: "" });
    },
    onError: (error) => reportError("Remove node failed", error),
  });

  const busy = createMutation.isPending || updateMutation.isPending;

  function openCreate() {
    setDraft(emptyDraft);
    setEditor({ mode: "create" });
  }

  function openEdit(node: FleetNodeView) {
    setDraft({
      name: node.name,
      baseUrl: node.baseUrl,
      token: "",
      enabled: node.enabled,
      clearToken: false,
    });
    setEditor({ mode: "edit", node });
  }

  function save() {
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    if (!name || !baseUrl) {
      return;
    }
    if (editor?.mode === "edit") {
      const patch: FleetNodeUpdate = { name, baseUrl, enabled: draft.enabled };
      if (draft.clearToken) {
        patch.token = "";
      } else if (draft.token) {
        patch.token = draft.token;
      }
      updateMutation.mutate({ id: editor.node.id, patch });
      return;
    }
    const input: FleetNodeCreate = { name, baseUrl, enabled: draft.enabled };
    if (draft.token) {
      input.token = draft.token;
    }
    createMutation.mutate(input);
  }

  function renderNode(node: FleetNodeView) {
    const state = reachability(node, fleetByNodeId.get(node.id));
    const badge = (
      <Badge color={state.color} variant="light">
        {state.label}
      </Badge>
    );
    return (
      <Paper key={node.id} withBorder p="sm" radius="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Group gap="sm" align="flex-start" wrap="nowrap">
            <ThemeIcon color="blue" variant="light" radius="sm" size={34}>
              <Server size={18} />
            </ThemeIcon>
            <Stack gap={4}>
              <Group gap="xs" wrap="wrap">
                <Text fw={650}>{node.name}</Text>
                {state.tooltip ? (
                  <Tooltip label={state.tooltip}>{badge}</Tooltip>
                ) : (
                  badge
                )}
                <Badge
                  variant={node.hasToken ? "light" : "outline"}
                  color="gray"
                >
                  {node.hasToken ? "token set" : "no token"}
                </Badge>
              </Group>
              <Text c="dimmed" size="xs">
                {node.baseUrl}
              </Text>
            </Stack>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <ActionIcon
              aria-label="Edit node"
              variant="subtle"
              onClick={() => openEdit(node)}
            >
              <Pencil size={16} />
            </ActionIcon>
            <ActionIcon
              aria-label="Remove node"
              color="red"
              variant="subtle"
              loading={
                deleteMutation.isPending && deleteMutation.variables === node.id
              }
              onClick={() => deleteMutation.mutate(node.id)}
            >
              <Trash2 size={16} />
            </ActionIcon>
          </Group>
        </Group>
      </Paper>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Peer nodes are reached through this node; their tokens are stored
          locally and never returned.
        </Text>
        <Button leftSection={<Plus size={16} />} onClick={openCreate}>
          Add node
        </Button>
      </Group>

      {nodes.length === 0 ? (
        <Paper withBorder p="lg" radius="sm">
          <Text c="dimmed">No nodes registered yet.</Text>
        </Paper>
      ) : (
        <Stack gap="xs">{nodes.map(renderNode)}</Stack>
      )}

      <Modal
        opened={Boolean(editor)}
        onClose={() => setEditor(null)}
        title={
          editor?.mode === "edit" ? `Edit ${editor.node.name}` : "Add node"
        }
        size="lg"
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={draft.name}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, name: value }));
            }}
          />
          <TextInput
            label="Base URL"
            placeholder="http://192.168.1.10:8787"
            value={draft.baseUrl}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, baseUrl: value }));
            }}
          />
          <PasswordInput
            label="Token"
            description={
              editor?.mode === "edit"
                ? "Leave blank to keep the current token"
                : "The peer's admin password (optional if its auth is off)"
            }
            value={draft.token}
            disabled={draft.clearToken}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, token: value }));
            }}
          />
          {editor?.mode === "edit" && editor.node.hasToken && (
            <Switch
              label="Clear stored token"
              checked={draft.clearToken}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setDraft((current) => ({ ...current, clearToken: checked }));
              }}
            />
          )}
          <Switch
            label="Enabled"
            checked={draft.enabled}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setDraft((current) => ({ ...current, enabled: checked }));
            }}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!draft.name.trim() || !draft.baseUrl.trim()}
              onClick={save}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
