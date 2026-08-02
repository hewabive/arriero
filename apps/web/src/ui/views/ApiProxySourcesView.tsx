import type { ApiProxySourceRecord, ApiProxySourceUpdate } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  createApiProxySource,
  deleteApiProxySource,
  getApiProxySettings,
  listApiProxySources,
  updateApiProxySettings,
  updateApiProxySource,
} from "../../api/client";

type SourceEditor =
  | { mode: "create" }
  | { mode: "edit"; source: ApiProxySourceRecord };

type SourceDraft = {
  name: string;
  apiKey: string;
  note: string;
  enabled: boolean;
  blockedMessage: string;
};

const emptyDraft: SourceDraft = {
  name: "",
  apiKey: "",
  note: "",
  enabled: true,
  blockedMessage: "",
};

function draftFromRecord(source: ApiProxySourceRecord): SourceDraft {
  return {
    name: source.name,
    apiKey: "",
    note: source.note,
    enabled: source.enabled,
    blockedMessage: source.blockedMessage,
  };
}

export function ApiProxySourcesView() {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<SourceEditor | null>(null);
  const [draft, setDraft] = useState<SourceDraft>(emptyDraft);

  const sourcesQuery = useQuery({
    queryKey: ["api-proxy-sources"],
    queryFn: listApiProxySources,
  });
  const sources = sourcesQuery.data?.data ?? [];

  const settingsQuery = useQuery({
    queryKey: ["api-proxy-settings"],
    queryFn: getApiProxySettings,
  });
  const allowAnonymous = settingsQuery.data?.data.allowAnonymous ?? true;

  const settingsMutation = useMutation({
    mutationFn: updateApiProxySettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["api-proxy-settings"] });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Settings update failed",
        message: (error as Error).message,
      }),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["api-proxy-sources"] });

  const closeEditor = () => {
    setEditor(null);
    setDraft(emptyDraft);
  };

  const createMutation = useMutation({
    mutationFn: createApiProxySource,
    onSuccess: async () => {
      await invalidate();
      closeEditor();
      notifications.show({
        title: "Source saved",
        message: "Requests with this key will be labeled with the source.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Source save failed",
        message: (error as Error).message,
      }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApiProxySourceUpdate }) =>
      updateApiProxySource(id, input),
    onSuccess: async () => {
      await invalidate();
      closeEditor();
      notifications.show({ title: "Source updated", message: "Saved." });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Source update failed",
        message: (error as Error).message,
      }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateApiProxySource(id, { enabled }),
    onSuccess: invalidate,
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Source update failed",
        message: (error as Error).message,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteApiProxySource,
    onSuccess: async () => {
      await invalidate();
      notifications.show({ title: "Source deleted", message: "Removed." });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Source delete failed",
        message: (error as Error).message,
      }),
  });

  function openCreate() {
    setEditor({ mode: "create" });
    setDraft(emptyDraft);
  }

  function openEdit(source: ApiProxySourceRecord) {
    setEditor({ mode: "edit", source });
    setDraft(draftFromRecord(source));
  }

  function generateKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const value = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    setDraft((current) => ({ ...current, apiKey: `sk-${value}` }));
  }

  function save() {
    if (editor?.mode === "edit") {
      const input: ApiProxySourceUpdate = {
        name: draft.name,
        enabled: draft.enabled,
        note: draft.note,
        blockedMessage: draft.blockedMessage,
      };
      if (draft.apiKey.trim()) {
        input.apiKey = draft.apiKey.trim();
      }
      updateMutation.mutate({ id: editor.source.id, input });
      return;
    }
    createMutation.mutate({
      name: draft.name,
      enabled: draft.enabled,
      note: draft.note,
      blockedMessage: draft.blockedMessage,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    });
  }

  const busy = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack gap="md">
      <Paper withBorder p="md">
        <Group justify="space-between" mb="sm" align="flex-start">
          <Switch
            label="Allow anonymous requests"
            description={
              allowAnonymous
                ? "Unknown or missing keys pass through as anonymous — sources only label requests. Disabled sources are always rejected."
                : "Requests without a configured source key are rejected with 401. Disabled sources are always rejected."
            }
            checked={allowAnonymous}
            disabled={settingsQuery.isPending || settingsMutation.isPending}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              settingsMutation.mutate({ allowAnonymous: checked });
            }}
          />
          <Button leftSection={<Plus size={16} />} onClick={openCreate}>
            New source
          </Button>
        </Group>

        <Table striped withTableBorder fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>API key</Table.Th>
              <Table.Th>Enabled</Table.Th>
              <Table.Th>Note</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sources.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text size="sm" c="dimmed">
                    No sources yet.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {sources.map((source) => (
              <Table.Tr key={source.id}>
                <Table.Td>{source.name}</Table.Td>
                <Table.Td>
                  {source.keyConfigured ? (
                    <Badge color="teal" variant="light">
                      configured
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      none
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={source.enabled}
                    disabled={toggleMutation.isPending}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked;
                      toggleMutation.mutate({ id: source.id, enabled });
                    }}
                  />
                </Table.Td>
                <Table.Td>{source.note || "—"}</Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    <Tooltip label="Edit">
                      <ActionIcon
                        variant="subtle"
                        onClick={() => openEdit(source)}
                      >
                        <Pencil size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        loading={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(source.id)}
                      >
                        <Trash2 size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>

      <Modal
        opened={editor !== null}
        onClose={closeEditor}
        title={editor?.mode === "edit" ? "Edit source" : "New source"}
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            placeholder="e.g. cline, openwebui, scripts"
            value={draft.name}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, name: value }));
            }}
          />
          <TextInput
            label="API key"
            description={
              editor?.mode === "edit"
                ? "Leave blank to keep the current key."
                : "Clients send this as Authorization: Bearer <key> or x-api-key."
            }
            placeholder={
              editor?.mode === "edit" && editor.source.keyConfigured
                ? "•••••••• (unchanged)"
                : "sk-…"
            }
            value={draft.apiKey}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, apiKey: value }));
            }}
            rightSection={
              <Tooltip label="Generate">
                <ActionIcon variant="subtle" onClick={generateKey}>
                  <RefreshCw size={16} />
                </ActionIcon>
              </Tooltip>
            }
          />
          <Textarea
            label="Note"
            autosize
            minRows={1}
            value={draft.note}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, note: value }));
            }}
          />
          <Switch
            label="Enabled"
            checked={draft.enabled}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setDraft((current) => ({ ...current, enabled: checked }));
            }}
          />
          <Textarea
            label="Blocked message"
            description="Returned to the caller while this source is disabled. Empty uses a default message."
            autosize
            minRows={1}
            value={draft.blockedMessage}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, blockedMessage: value }));
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeEditor}>
              Cancel
            </Button>
            <Button loading={busy} onClick={save} disabled={!draft.name.trim()}>
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
