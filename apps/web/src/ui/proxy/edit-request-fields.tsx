import {
  apiProxyRequestToolName,
  applyApiProxyRequestEdits,
  type ApiProxyEditRequestOperation,
  type ApiProxyRequestEditOutcome,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { Blocks, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  EditOperationDraft,
  PipelineNodeDraftOf,
  PipelineNodeDraftPatch,
} from "./forms";
import { editOperationFromDraft } from "./forms";
import { useNarrowScreen } from "../hooks/use-narrow-screen";

const monoInputStyles = {
  input: { fontFamily: "monospace" },
} as const;

const operationKindOptions: Array<{
  value: EditOperationDraft["kind"];
  label: string;
}> = [
  { value: "remove-tool", label: "Remove tool" },
  { value: "replace-tool", label: "Replace tool" },
  { value: "add-tool", label: "Add tool" },
  { value: "set-field", label: "Set body field" },
  { value: "remove-field", label: "Remove body field" },
];

const customToolSkeleton = '{\n  "name": ""\n}';

type ParsedOperations = {
  items: Array<{
    draft: EditOperationDraft;
    operation: ApiProxyEditRequestOperation | null;
    error: string | null;
  }>;
  operations: ApiProxyEditRequestOperation[];
  draftIndexByOperationIndex: number[];
};

function parseOperations(drafts: EditOperationDraft[]): ParsedOperations {
  const items = drafts.map((draft) => {
    const result = editOperationFromDraft(draft);
    return { draft, operation: result.operation, error: result.error };
  });
  const operations: ApiProxyEditRequestOperation[] = [];
  const draftIndexByOperationIndex: number[] = [];
  items.forEach((item, draftIndex) => {
    if (item.operation) {
      operations.push(item.operation);
      draftIndexByOperationIndex.push(draftIndex);
    }
  });
  return { items, operations, draftIndexByOperationIndex };
}

function parseSampleBody(text: string): {
  body: unknown;
  error: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { body: null, error: null };
  }
  try {
    return { body: JSON.parse(trimmed), error: null };
  } catch (error) {
    return { body: null, error: (error as Error).message };
  }
}

function sampleTools(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const tools = (body as Record<string, unknown>).tools;
  return Array.isArray(tools) ? tools : [];
}

type ToolBlockStatus =
  | { kind: "kept" }
  | { kind: "removed"; opNumber: number }
  | { kind: "replaced"; opNumber: number };

function toolBlockStatus(
  name: string | null,
  outcomes: Map<number, ApiProxyRequestEditOutcome>,
): ToolBlockStatus {
  if (name === null) {
    return { kind: "kept" };
  }
  for (const [draftIndex, outcome] of outcomes) {
    if (!outcome.toolNames.includes(name)) {
      continue;
    }
    if (outcome.kind === "remove-tool") {
      return { kind: "removed", opNumber: draftIndex + 1 };
    }
    if (outcome.kind === "replace-tool") {
      return { kind: "replaced", opNumber: draftIndex + 1 };
    }
  }
  return { kind: "kept" };
}

function OperationCard(props: {
  index: number;
  draft: EditOperationDraft;
  error: string | null;
  outcome: ApiProxyRequestEditOutcome | null;
  onPatch: (patch: Partial<EditOperationDraft>) => void;
  onRemove: () => void;
}) {
  const { draft } = props;
  const needsName =
    draft.kind === "remove-tool" || draft.kind === "replace-tool";
  const needsPath = draft.kind === "set-field" || draft.kind === "remove-field";
  const needsValue =
    draft.kind === "replace-tool" ||
    draft.kind === "add-tool" ||
    draft.kind === "set-field";
  const isFieldValue = draft.kind === "set-field";
  return (
    <Paper withBorder p="xs" radius="sm">
      <Stack gap={6}>
        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <Select
            size="xs"
            label={`Operation #${props.index + 1}`}
            data={operationKindOptions}
            value={draft.kind}
            allowDeselect={false}
            onChange={(value) =>
              props.onPatch({
                kind: (value ?? "remove-tool") as EditOperationDraft["kind"],
              })
            }
          />
          <ActionIcon
            aria-label="Remove operation"
            variant="subtle"
            color="red"
            size="sm"
            onClick={props.onRemove}
          >
            <Trash2 size={14} />
          </ActionIcon>
        </Group>
        {needsName && (
          <TextInput
            size="xs"
            label="Tool name"
            placeholder="Bash or mcp__*"
            value={draft.toolName}
            styles={monoInputStyles}
            onChange={(event) => {
              const toolName = event.currentTarget.value;
              props.onPatch({ toolName });
            }}
          />
        )}
        {needsPath && (
          <TextInput
            size="xs"
            label="Field path"
            placeholder="max_tokens or stream_options.include_usage"
            value={draft.path}
            styles={monoInputStyles}
            onChange={(event) => {
              const path = event.currentTarget.value;
              props.onPatch({ path });
            }}
          />
        )}
        {needsValue && (
          <Textarea
            size="xs"
            label={isFieldValue ? "Value JSON" : "Tool JSON"}
            placeholder={isFieldValue ? "512" : customToolSkeleton}
            autosize
            minRows={isFieldValue ? 1 : 3}
            maxRows={12}
            value={draft.valueText}
            styles={monoInputStyles}
            error={props.error && draft.valueText.trim() ? props.error : null}
            onChange={(event) => {
              const valueText = event.currentTarget.value;
              props.onPatch({ valueText });
            }}
          />
        )}
        <Group justify="space-between">
          <Switch
            size="xs"
            label="Enabled"
            checked={draft.enabled}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              props.onPatch({ enabled });
            }}
          />
          {props.error && (
            <Badge color="red" variant="light" size="sm">
              {props.error}
            </Badge>
          )}
          {!props.error && props.outcome && (
            <Badge
              color={props.outcome.matched > 0 ? "teal" : "gray"}
              variant="light"
              size="sm"
              maw={320}
            >
              {props.outcome.detail}
            </Badge>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

export function EditRequestFields(props: {
  node: PipelineNodeDraftOf<"edit-request">;
  updateNode: (
    nodeId: string,
    patch: PipelineNodeDraftPatch<"edit-request">,
  ) => void;
}) {
  const { node } = props;
  const isNarrow = useNarrowScreen();
  const [editorOpened, setEditorOpened] = useState(false);
  const [sampleText, setSampleText] = useState("");
  const [showResult, setShowResult] = useState(false);

  const drafts = node.editOperations;
  const setDrafts = (next: EditOperationDraft[]) =>
    props.updateNode(node.id, { editOperations: next });
  const patchDraft = (index: number, patch: Partial<EditOperationDraft>) =>
    setDrafts(
      drafts.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  const appendDraft = (draft: EditOperationDraft) =>
    setDrafts([...drafts, draft]);

  const parsed = useMemo(() => parseOperations(drafts), [drafts]);
  const sample = useMemo(() => parseSampleBody(sampleText), [sampleText]);
  const preview = useMemo(
    () =>
      sample.body !== null
        ? applyApiProxyRequestEdits(sample.body, parsed.operations)
        : null,
    [sample.body, parsed.operations],
  );
  const outcomeByDraftIndex = useMemo(() => {
    const map = new Map<number, ApiProxyRequestEditOutcome>();
    if (!preview) {
      return map;
    }
    for (const outcome of preview.outcomes) {
      const draftIndex = parsed.draftIndexByOperationIndex[outcome.index];
      if (draftIndex !== undefined) {
        map.set(draftIndex, outcome);
      }
    }
    return map;
  }, [preview, parsed.draftIndexByOperationIndex]);

  const tools = useMemo(() => sampleTools(sample.body), [sample.body]);

  const operationCards = drafts.map((draft, index) => (
    <OperationCard
      key={index}
      index={index}
      draft={draft}
      error={parsed.items[index]?.error ?? null}
      outcome={outcomeByDraftIndex.get(index) ?? null}
      onPatch={(patch) => patchDraft(index, patch)}
      onRemove={() => setDrafts(drafts.filter((_, i) => i !== index))}
    />
  ));

  const addButtons = (
    <Group gap="xs">
      <Button
        variant="light"
        size="xs"
        leftSection={<Plus size={14} />}
        onClick={() =>
          appendDraft({
            kind: "remove-tool",
            toolName: "",
            path: "",
            valueText: "",
            enabled: true,
          })
        }
      >
        Add operation
      </Button>
      <Button
        variant="light"
        size="xs"
        leftSection={<Blocks size={14} />}
        onClick={() => setEditorOpened(true)}
      >
        Block editor
      </Button>
    </Group>
  );

  return (
    <>
      <Stack gap="xs">
        {drafts.length === 0 && (
          <Text c="dimmed" size="sm">
            No operations yet. Each operation edits the request before routing:
            remove, replace or add a tool, or set/remove a body field.
          </Text>
        )}
        {operationCards}
        {addButtons}
        <Text c="dimmed" size="xs">
          Tool operations target the request tools array (OpenAI and Anthropic
          shapes); tool name matches exactly, * matches any characters. Field
          operations set or remove any body field by path: dot-separated keys
          with [n] array indices, e.g. max_tokens or messages[0].role; set
          creates missing intermediate objects. Open the block editor to preview
          operations against a sample request.
        </Text>
      </Stack>
      <Modal
        opened={editorOpened}
        onClose={() => setEditorOpened(false)}
        title="Request block editor"
        size="xl"
        fullScreen={isNarrow}
      >
        <Stack gap="sm">
          <Textarea
            label="Sample request body (JSON)"
            description="Paste a body from a saved request file or the test bench — operations below preview against it live. The sample is not stored."
            placeholder='{"model": "...", "messages": [...], "tools": [...]}'
            autosize
            minRows={5}
            maxRows={12}
            value={sampleText}
            styles={monoInputStyles}
            error={sample.error}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setSampleText(value);
            }}
          />
          {sample.body !== null && (
            <Stack gap={6}>
              <Text fw={600} size="sm">
                Tools in the sample ({tools.length})
              </Text>
              {tools.length === 0 && (
                <Text c="dimmed" size="sm">
                  The sample has no tools array.
                </Text>
              )}
              {tools.map((tool, index) => {
                const name = apiProxyRequestToolName(tool);
                const status = toolBlockStatus(name, outcomeByDraftIndex);
                return (
                  <Paper key={index} withBorder p="xs" radius="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Text
                          size="sm"
                          fw={600}
                          style={{
                            fontFamily: "monospace",
                            ...(status.kind === "removed"
                              ? { textDecoration: "line-through" }
                              : {}),
                          }}
                          {...(status.kind === "removed"
                            ? { c: "dimmed" }
                            : {})}
                          truncate
                        >
                          {name ?? "(unnamed tool)"}
                        </Text>
                        {status.kind === "removed" && (
                          <Badge color="red" variant="light" size="sm">
                            removed by #{status.opNumber}
                          </Badge>
                        )}
                        {status.kind === "replaced" && (
                          <Badge color="yellow" variant="light" size="sm">
                            replaced by #{status.opNumber}
                          </Badge>
                        )}
                      </Group>
                      <Group gap={4} wrap="nowrap">
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          color="red"
                          disabled={name === null}
                          onClick={() =>
                            name !== null &&
                            appendDraft({
                              kind: "remove-tool",
                              toolName: name,
                              path: "",
                              valueText: "",
                              enabled: true,
                            })
                          }
                        >
                          Remove
                        </Button>
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          disabled={name === null}
                          onClick={() =>
                            name !== null &&
                            appendDraft({
                              kind: "replace-tool",
                              toolName: name,
                              path: "",
                              valueText: JSON.stringify(tool, null, 2),
                              enabled: true,
                            })
                          }
                        >
                          Replace
                        </Button>
                      </Group>
                    </Group>
                  </Paper>
                );
              })}
              <Group gap="xs">
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<Plus size={14} />}
                  onClick={() =>
                    appendDraft({
                      kind: "add-tool",
                      toolName: "",
                      path: "",
                      valueText: customToolSkeleton,
                      enabled: true,
                    })
                  }
                >
                  Add custom tool
                </Button>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<Plus size={14} />}
                  onClick={() =>
                    appendDraft({
                      kind: "set-field",
                      toolName: "",
                      path: "",
                      valueText: "",
                      enabled: true,
                    })
                  }
                >
                  Set body field
                </Button>
              </Group>
            </Stack>
          )}
          <Stack gap={6}>
            <Text fw={600} size="sm">
              Operations ({drafts.length})
            </Text>
            {drafts.length === 0 && (
              <Text c="dimmed" size="sm">
                No operations yet — use the buttons on the tool blocks above.
              </Text>
            )}
            {operationCards}
          </Stack>
          {preview && (
            <>
              <Button
                variant="subtle"
                size="xs"
                onClick={() => setShowResult((value) => !value)}
              >
                {showResult ? "Hide edited body" : "Show edited body"}
              </Button>
              <Collapse in={showResult}>
                <Code block style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(preview.body, null, 2)}
                </Code>
              </Collapse>
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
