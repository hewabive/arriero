import type { ApiProxySourceRecord, ApiProxySourceUpdate } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  EmptyState,
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
  listApiProxySources,
  updateApiProxySource,
} from "../../api/client";
import { useApiProxySettings } from "../proxy/use-api-proxy-settings";

type SourceEditor =
  | { mode: "create" }
  | { mode: "edit"; source: ApiProxySourceRecord };

type SourceDraft = {
  name: string;
  apiKey: string;
  clearApiKey: boolean;
  note: string;
  enabled: boolean;
  blockedMessage: string;
};

const emptyDraft: SourceDraft = {
  name: "",
  apiKey: "",
  clearApiKey: false,
  note: "",
  enabled: true,
  blockedMessage: "",
};

function draftFromRecord(source: ApiProxySourceRecord): SourceDraft {
  return {
    name: source.name,
    apiKey: "",
    clearApiKey: false,
    note: source.note,
    enabled: source.enabled,
    blockedMessage: source.blockedMessage,
  };
}

function notifyFailure(title: string) {
  return (error: unknown) =>
    notifications.show({
      color: "red",
      title,
      message: (error as Error).message,
    });
}

function RejectionMessageInput({
  label,
  description,
  value,
  disabled,
  onSave,
}: {
  label: string;
  description: string;
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
}) {
  return (
    <Textarea
      key={value}
      label={label}
      description={description}
      autosize
      minRows={1}
      defaultValue={value}
      disabled={disabled}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next !== value) {
          onSave(next);
        }
      }}
    />
  );
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

  const {
    query: settingsQuery,
    mutation: settingsMutation,
    settings,
  } = useApiProxySettings(notifyFailure("Settings update failed"));
  const allowAnonymous = settings?.allowAnonymous ?? true;

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
    onError: notifyFailure("Source save failed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApiProxySourceUpdate }) =>
      updateApiProxySource(id, input),
    onSuccess: async () => {
      await invalidate();
      closeEditor();
      notifications.show({ title: "Source updated", message: "Saved." });
    },
    onError: notifyFailure("Source update failed"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateApiProxySource(id, { enabled }),
    onSuccess: invalidate,
    onError: notifyFailure("Source update failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteApiProxySource,
    onSuccess: async () => {
      await invalidate();
      notifications.show({ title: "Source deleted", message: "Removed." });
    },
    onError: notifyFailure("Source delete failed"),
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
      if (draft.clearApiKey) {
        input.apiKey = "";
      } else if (draft.apiKey.trim()) {
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
            description={`${
              allowAnonymous
                ? "Unknown or missing keys pass through as anonymous — sources only label requests."
                : "Requests without a configured source key are rejected with 423."
            } Disabled sources are always rejected.`}
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

        {!allowAnonymous && (
          <Group grow mb="sm" align="flex-start">
            <RejectionMessageInput
              label="Anonymous rejection message"
              description="Returned to requests that send no API key. Empty uses a default message."
              value={settings?.anonymousBlockedMessage ?? ""}
              disabled={settingsMutation.isPending}
              onSave={(anonymousBlockedMessage) =>
                settingsMutation.mutate({ anonymousBlockedMessage })
              }
            />
            <RejectionMessageInput
              label="Unknown key rejection message"
              description="Returned to requests whose key matches no source. Empty uses a default message."
              value={settings?.unknownKeyBlockedMessage ?? ""}
              disabled={settingsMutation.isPending}
              onSave={(unknownKeyBlockedMessage) =>
                settingsMutation.mutate({ unknownKeyBlockedMessage })
              }
            />
          </Group>
        )}

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
                  <EmptyState size="sm" title="No sources yet" py="sm" />
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
                    disabled={
                      toggleMutation.isPending &&
                      toggleMutation.variables.id === source.id
                    }
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
            disabled={draft.clearApiKey}
            description={
              editor?.mode === "edit"
                ? "Leave blank to keep the current key."
                : "Clients send this as Authorization: Bearer <key> or x-api-key."
            }
            placeholder={
              draft.clearApiKey
                ? "Key will be removed on save"
                : editor?.mode === "edit" && editor.source.keyConfigured
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
                <ActionIcon
                  variant="subtle"
                  disabled={draft.clearApiKey}
                  onClick={generateKey}
                >
                  <RefreshCw size={16} />
                </ActionIcon>
              </Tooltip>
            }
          />
          {editor?.mode === "edit" && editor.source.keyConfigured && (
            <Group>
              <Button
                size="compact-xs"
                variant="light"
                color={draft.clearApiKey ? "gray" : "red"}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    clearApiKey: !current.clearApiKey,
                    apiKey: "",
                  }))
                }
              >
                {draft.clearApiKey ? "Keep current key" : "Clear key"}
              </Button>
            </Group>
          )}
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
