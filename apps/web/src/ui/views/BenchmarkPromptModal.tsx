import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import type { BenchmarkViewController } from "./use-benchmark-view";

function asTokens(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 512;
}

export function BenchmarkPromptModal({ fm }: { fm: BenchmarkViewController }) {
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("custom");
  const [language, setLanguage] = useState<string>("en");
  const [prefillClass, setPrefillClass] = useState<string>("short");
  const [maxTokens, setMaxTokens] = useState<number>(512);
  const [system, setSystem] = useState("");
  const [user, setUser] = useState("");

  const customPrompts = fm.prompts.filter(
    (prompt) => prompt.source === "custom",
  );
  const canSave = title.trim().length > 0 && user.trim().length > 0;

  function save() {
    if (!canSave) return;
    fm.createPrompt({
      title: title.trim(),
      topic: topic.trim() || "custom",
      language,
      prefillClass: prefillClass === "long" ? "long" : "short",
      maxTokens,
      messages: [
        ...(system.trim()
          ? [{ role: "system" as const, content: system }]
          : []),
        { role: "user" as const, content: user },
      ],
    });
  }

  return (
    <Modal
      opened={fm.promptModalOpened}
      onClose={() => fm.setPromptModalOpened(false)}
      title="Custom benchmark prompts"
      size="lg"
    >
      <Stack gap="sm">
        <TextInput
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            label="Topic"
            w={140}
            value={topic}
            onChange={(event) => setTopic(event.currentTarget.value)}
          />
          <Select
            label="Language"
            w={100}
            data={["en", "ru"]}
            value={language}
            onChange={(value) => setLanguage(value ?? "en")}
          />
          <Select
            label="Prefill"
            w={110}
            data={[
              { value: "short", label: "short" },
              { value: "long", label: "long" },
            ]}
            value={prefillClass}
            onChange={(value) => setPrefillClass(value ?? "short")}
          />
          <NumberInput
            label="Max tokens"
            w={120}
            min={1}
            max={32768}
            value={maxTokens}
            onChange={(value) => setMaxTokens(asTokens(value))}
          />
        </Group>
        <Textarea
          label="System message (optional)"
          autosize
          minRows={2}
          maxRows={6}
          value={system}
          onChange={(event) => setSystem(event.currentTarget.value)}
        />
        <Textarea
          label="User message"
          autosize
          minRows={4}
          maxRows={12}
          value={user}
          onChange={(event) => setUser(event.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button
            onClick={save}
            disabled={!canSave}
            loading={fm.createPromptPending}
          >
            Save prompt
          </Button>
        </Group>

        {customPrompts.length > 0 && (
          <>
            <Divider label="Existing custom prompts" />
            <Stack gap={4}>
              {customPrompts.map((prompt) => (
                <Group key={prompt.id} justify="space-between" wrap="nowrap">
                  <Text size="sm" truncate>
                    {prompt.title} · {prompt.topic}/{prompt.language}
                  </Text>
                  <Tooltip label="Delete prompt">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => fm.deletePrompt(prompt.id)}
                    >
                      <Trash2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Modal>
  );
}
