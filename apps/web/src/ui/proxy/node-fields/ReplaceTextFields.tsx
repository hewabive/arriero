import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@mantine/core";
import { Maximize2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { PipelineNodeDraftOf } from "../forms";
import { useNarrowScreen } from "../../hooks/use-narrow-screen";
import type { PipelineEditorContext } from "./context";
import { PortSelect } from "./PortSelect";

const replacementInputStyles = {
  input: { fontFamily: "monospace" },
} as const;

type ReplacementView = "raw" | "escaped";

const replacementViewOptions = [
  { value: "raw", label: "Plain text" },
  { value: "escaped", label: "JSON string" },
];

function escapeRuleDisplay(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

const displayEscapes: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function unescapeRuleDisplay(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index] as string;
    if (char !== "\\" || index + 1 >= value.length) {
      out += char;
      index += 1;
      continue;
    }
    const marker = value[index + 1] as string;
    if (marker === "u" && index + 6 <= value.length) {
      const hex = value.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }
    }
    const decoded = displayEscapes[marker];
    if (decoded !== undefined) {
      out += decoded;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function RuleTextarea(props: {
  view: ReplacementView;
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder: string;
  size: "xs" | "sm";
  minRows: number;
  maxRows: number;
}) {
  const display =
    props.view === "escaped" ? escapeRuleDisplay(props.value) : props.value;
  const [text, setText] = useState(display);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) {
      setText(display);
    }
  }, [display, focused]);
  return (
    <Textarea
      size={props.size}
      label={props.label}
      placeholder={props.placeholder}
      autosize
      minRows={props.minRows}
      maxRows={props.maxRows}
      value={text}
      styles={replacementInputStyles}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        props.onValueChange(
          props.view === "escaped" ? unescapeRuleDisplay(next) : next,
        );
      }}
    />
  );
}

type ReplaceTextNodeDraft = PipelineNodeDraftOf<"replace-text">;

export function ReplaceTextFields(props: {
  node: ReplaceTextNodeDraft;
  ctx: PipelineEditorContext;
}) {
  const { node, ctx } = props;
  const isNarrow = useNarrowScreen();
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [view, setView] = useState<ReplacementView>("raw");
  const rules = node.replacements;
  const setRules = (next: ReplaceTextNodeDraft["replacements"]) =>
    ctx.updateNode(node.id, { replacements: next });
  const patchRule = (
    index: number,
    patch: Partial<ReplaceTextNodeDraft["replacements"][number]>,
  ) =>
    setRules(
      rules.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  const detailRule = detailIndex === null ? null : (rules[detailIndex] ?? null);

  return (
    <>
      <Stack gap="xs">
        <Switch
          size="sm"
          label="Transform request text"
          description="Apply rules to string fields before the request continues through the graph."
          checked={node.replaceRequest}
          onChange={(event) =>
            ctx.updateNode(node.id, {
              replaceRequest: event.currentTarget.checked,
            })
          }
        />
        <Switch
          size="sm"
          label="Transform response text"
          description="Apply rules to visible assistant text while the response unwinds toward the client."
          checked={node.replaceResponse}
          onChange={(event) =>
            ctx.updateNode(node.id, {
              replaceResponse: event.currentTarget.checked,
            })
          }
        />
        <Group grow align="flex-start">
          <Switch
            size="xs"
            label="Include reasoning"
            checked={node.replaceResponseReasoning}
            disabled={!node.replaceResponse}
            onChange={(event) =>
              ctx.updateNode(node.id, {
                replaceResponseReasoning: event.currentTarget.checked,
              })
            }
          />
          <Switch
            size="xs"
            label="Include tool arguments"
            checked={node.replaceResponseToolArguments}
            disabled={!node.replaceResponse}
            onChange={(event) =>
              ctx.updateNode(node.id, {
                replaceResponseToolArguments: event.currentTarget.checked,
              })
            }
          />
        </Group>
        {rules.length === 0 && (
          <Text c="dimmed" size="sm">
            No replacements yet. Each rule rewrites matching text in the
            selected request and response surfaces.
          </Text>
        )}
        {rules.length > 0 && (
          <SegmentedControl
            size="xs"
            data={replacementViewOptions}
            value={view}
            onChange={(value) =>
              setView(value === "escaped" ? "escaped" : "raw")
            }
          />
        )}
        {rules.map((rule, index) => (
          <Paper key={index} withBorder p="xs" radius="sm">
            <Stack gap={6}>
              <RuleTextarea
                view={view}
                size="xs"
                label="Find"
                placeholder="text to find"
                minRows={1}
                maxRows={4}
                value={rule.find}
                onValueChange={(find) => patchRule(index, { find })}
              />
              <RuleTextarea
                view={view}
                size="xs"
                label="Replace with"
                placeholder="replacement (empty deletes the match)"
                minRows={1}
                maxRows={4}
                value={rule.replace}
                onValueChange={(replace) => patchRule(index, { replace })}
              />
              <Group justify="space-between">
                <Switch
                  size="xs"
                  label="Enabled"
                  checked={rule.enabled}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    patchRule(index, { enabled });
                  }}
                />
                <Group gap={4}>
                  <ActionIcon
                    aria-label="Edit replacement rule in a large editor"
                    variant="subtle"
                    size="sm"
                    onClick={() => setDetailIndex(index)}
                  >
                    <Maximize2 size={14} />
                  </ActionIcon>
                  <ActionIcon
                    aria-label="Remove replacement rule"
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() =>
                      setRules(rules.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 size={14} />
                  </ActionIcon>
                </Group>
              </Group>
            </Stack>
          </Paper>
        ))}
        <Button
          variant="light"
          size="xs"
          leftSection={<Plus size={14} />}
          onClick={() =>
            setRules([...rules, { find: "", replace: "", enabled: true }])
          }
        >
          Add replacement
        </Button>
        <Text c="dimmed" size="xs">
          {
            'Rules use literal matching. The toggle only changes how rules are displayed and typed: the "JSON string" view shows text exactly as it appears inside a JSON string (quotes, line breaks and tabs read \\" \\n \\t) — paste text copied from a saved request or response file there.'
          }
        </Text>
      </Stack>
      <PortSelect
        label="Next"
        ctx={ctx}
        excludeNodeId={node.id}
        value={node.portNext}
        onChange={(portNext) => ctx.updateNode(node.id, { portNext })}
      />
      <Modal
        opened={detailRule !== null}
        onClose={() => setDetailIndex(null)}
        title={`Replacement rule #${(detailIndex ?? 0) + 1}`}
        size="xl"
        fullScreen={isNarrow}
      >
        {detailRule && detailIndex !== null && (
          <Stack gap="sm">
            <SegmentedControl
              data={replacementViewOptions}
              value={view}
              onChange={(value) =>
                setView(value === "escaped" ? "escaped" : "raw")
              }
            />
            <RuleTextarea
              view={view}
              size="sm"
              label="Find"
              placeholder="text to find"
              minRows={6}
              maxRows={20}
              value={detailRule.find}
              onValueChange={(find) => patchRule(detailIndex, { find })}
            />
            <RuleTextarea
              view={view}
              size="sm"
              label="Replace with"
              placeholder="replacement (empty deletes the match)"
              minRows={6}
              maxRows={20}
              value={detailRule.replace}
              onValueChange={(replace) => patchRule(detailIndex, { replace })}
            />
            <Text c="dimmed" size="xs">
              {
                'Rules use literal matching. The toggle only changes how rules are displayed and typed: the "JSON string" view shows text exactly as it appears inside a JSON string (quotes, line breaks and tabs read \\" \\n \\t) — paste text copied from a saved request or response file there.'
              }
            </Text>
            <Group justify="space-between">
              <Switch
                label="Enabled"
                checked={detailRule.enabled}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  patchRule(detailIndex, { enabled });
                }}
              />
              <Button variant="light" onClick={() => setDetailIndex(null)}>
                Done
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
