import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { Plus, Save, Trash2 } from "lucide-react";

import { ReasoningOverrideSelect } from "../components/ReasoningOverrideSelect";
import { SecretInput } from "../components/SecretInput";
import type { EndpointDraft, EndpointEditor } from "./forms";

type EndpointEditorModalProps = {
  editor: EndpointEditor | null;
  draft: EndpointDraft;
  busy: boolean;
  onClose: () => void;
  onSave: () => void;
  onDraftChange: (draft: EndpointDraft) => void;
};

const authHeaderPlaceholderByProfile: Record<EndpointDraft["profile"], string> =
  {
    openai: "authorization: Bearer <key>",
    "llama-native": "authorization: Bearer <key>",
    anthropic: "x-api-key: <key>",
  };

export function EndpointEditorModal(props: EndpointEditorModalProps) {
  const { draft, onDraftChange } = props;
  const hasEnvVar = draft.apiKeyEnvVar.trim().length > 0;
  const hasApiKey = draft.apiKey.trim().length > 0;

  const setHeader = (index: number, patch: { name?: string; value?: string }) =>
    onDraftChange({
      ...draft,
      extraHeaders: draft.extraHeaders.map((header, current) =>
        current === index ? { ...header, ...patch } : header,
      ),
    });

  return (
    <Modal
      opened={Boolean(props.editor)}
      onClose={props.onClose}
      title={
        props.editor?.mode === "edit"
          ? `Edit ${props.editor.endpoint.name}`
          : "Add API endpoint"
      }
      size="lg"
    >
      <Stack gap="sm">
        <Switch
          label="Enabled"
          checked={draft.enabled}
          onChange={(event) =>
            onDraftChange({ ...draft, enabled: event.currentTarget.checked })
          }
        />
        <TextInput
          label="Name"
          value={draft.name}
          onChange={(event) =>
            onDraftChange({ ...draft, name: event.target.value })
          }
        />
        <TextInput
          label="Base URL"
          placeholder="https://api.example.com/v1"
          value={draft.baseUrl}
          onChange={(event) =>
            onDraftChange({ ...draft, baseUrl: event.target.value })
          }
        />
        <Select
          allowDeselect={false}
          data={[
            { value: "openai", label: "OpenAI-compatible" },
            { value: "anthropic", label: "Anthropic-compatible" },
            { value: "llama-native", label: "llama.cpp native" },
          ]}
          label="Default API"
          value={draft.profile}
          onChange={(profile) =>
            onDraftChange({
              ...draft,
              profile: (profile ?? "openai") as EndpointDraft["profile"],
            })
          }
        />
        <ReasoningOverrideSelect
          value={draft.reasoning}
          onChange={(reasoning) => onDraftChange({ ...draft, reasoning })}
          autoLabel="None (pass reasoning fields through unchanged)"
          description="How the proxy maps client-requested reasoning effort for models served by this endpoint; None forwards the canonical fields as sent."
        />

        <Divider label="Authentication" labelPosition="left" />
        <Text c="dimmed" size="xs">
          Provide an API key (stored in .secrets.json) or the name of a server
          env var holding it — not both. The key is sent as{" "}
          {authHeaderPlaceholderByProfile[draft.profile]} unless you set a
          header override below.
        </Text>
        <Group grow align="flex-start">
          <SecretInput
            label="API key"
            disabled={hasEnvVar}
            placeholder={
              props.editor?.mode === "edit"
                ? "Leave blank to keep current key"
                : "sk-..."
            }
            value={draft.apiKey}
            onChange={(event) =>
              onDraftChange({ ...draft, apiKey: event.target.value })
            }
          />
          <TextInput
            label="…or env var name"
            disabled={hasApiKey}
            placeholder="OPENROUTER_API_KEY"
            value={draft.apiKeyEnvVar}
            onChange={(event) =>
              onDraftChange({ ...draft, apiKeyEnvVar: event.target.value })
            }
          />
        </Group>
        <TextInput
          label="Auth header override (optional)"
          placeholder="x-api-key"
          value={draft.authHeaderName}
          onChange={(event) =>
            onDraftChange({ ...draft, authHeaderName: event.target.value })
          }
        />

        <Divider label="Extra headers" labelPosition="left" />
        {draft.extraHeaders.length === 0 && (
          <Text c="dimmed" size="xs">
            Sent with every request (e.g. OpenRouter HTTP-Referer / X-Title).
          </Text>
        )}
        {draft.extraHeaders.map((header, index) => (
          <Group key={index} gap="xs" align="flex-end" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              placeholder="Header-Name"
              value={header.name}
              onChange={(event) =>
                setHeader(index, { name: event.target.value })
              }
            />
            <TextInput
              style={{ flex: 1 }}
              placeholder="value"
              value={header.value}
              onChange={(event) =>
                setHeader(index, { value: event.target.value })
              }
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() =>
                onDraftChange({
                  ...draft,
                  extraHeaders: draft.extraHeaders.filter(
                    (_, current) => current !== index,
                  ),
                })
              }
            >
              <Trash2 size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button
            size="xs"
            variant="light"
            leftSection={<Plus size={14} />}
            onClick={() =>
              onDraftChange({
                ...draft,
                extraHeaders: [...draft.extraHeaders, { name: "", value: "" }],
              })
            }
          >
            Add header
          </Button>
        </Group>

        <Divider label="Passthrough" labelPosition="left" />
        <Switch
          label="Expose all upstream models by name"
          description="Any model id this provider serves becomes callable; GET /v1/models proxies its catalog."
          checked={draft.passthrough}
          onChange={(event) =>
            onDraftChange({
              ...draft,
              passthrough: event.currentTarget.checked,
            })
          }
        />
        {draft.passthrough && (
          <Group grow align="flex-start">
            <Textarea
              label="Allow patterns"
              description="One glob per line; empty = allow all"
              placeholder={"anthropic/*\nopenai/*"}
              autosize
              minRows={2}
              value={draft.allowPatterns}
              onChange={(event) =>
                onDraftChange({ ...draft, allowPatterns: event.target.value })
              }
            />
            <Textarea
              label="Deny patterns"
              description="One glob per line"
              placeholder={"*-free\n*:online"}
              autosize
              minRows={2}
              value={draft.denyPatterns}
              onChange={(event) =>
                onDraftChange({ ...draft, denyPatterns: event.target.value })
              }
            />
          </Group>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<Save size={16} />}
            loading={props.busy}
            disabled={!draft.name.trim() || !draft.baseUrl.trim()}
            onClick={props.onSave}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
