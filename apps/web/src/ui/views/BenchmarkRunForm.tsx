import type { BenchmarkMode, BenchmarkScenarioInput } from "@arriero/core";
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  TouchSelect,
  substringOptionsFilter,
} from "../components/TouchCombobox";
import { createUiId } from "../utils/id";
import { countLabel } from "../utils/plural";
import type { BenchmarkViewController } from "./use-benchmark-view";

type CompositionRow = {
  uiId: string;
  promptId: string | null;
  count: number;
};

function newRow(): CompositionRow {
  return { uiId: createUiId(), promptId: null, count: 1 };
}

function asCount(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

export function BenchmarkRunForm({ fm }: { fm: BenchmarkViewController }) {
  const [instanceName, setInstanceName] = useState<string | null>(null);
  const [mode, setMode] = useState<BenchmarkMode>("parallel");
  const [rows, setRows] = useState<CompositionRow[]>([newRow()]);
  const [repetitions, setRepetitions] = useState<number>(1);
  const [totalRequests, setTotalRequests] = useState(2000);
  const [timeoutSeconds, setTimeoutSeconds] = useState(300);
  const [warmup, setWarmup] = useState(true);
  const [cacheBust, setCacheBust] = useState(true);
  const [label, setLabel] = useState("");
  const [temperature, setTemperature] = useState<number | string>("");
  const [seed, setSeed] = useState<number | string>("");

  const promptOptions = fm.prompts.map((prompt) => ({
    value: prompt.id,
    label: `${prompt.title} · ${prompt.topic}/${prompt.language} · ${prompt.prefillClass} input · max ${prompt.maxTokens} output${prompt.source === "custom" ? " · custom" : ""}`,
  }));
  const instanceOptions = fm.instances.map((instance) => ({
    value: instance.name,
    label: `${instance.name} (${instance.kind})`,
  }));

  const composition = rows
    .filter((row) => row.promptId !== null)
    .map((row) => ({ promptId: row.promptId as string, count: row.count }));
  const canStart =
    instanceName !== null &&
    composition.length > 0 &&
    composition.length <= 32 &&
    !fm.startPending &&
    !fm.runs.some((run) => run.status === "running") &&
    (mode !== "sustained" ||
      totalRequests >=
        composition.reduce((sum, entry) => sum + entry.count, 0));
  const clients = composition.reduce((sum, entry) => sum + entry.count, 0);

  function updateRow(uiId: string, patch: Partial<CompositionRow>) {
    setRows((current) =>
      current.map((row) => (row.uiId === uiId ? { ...row, ...patch } : row)),
    );
  }

  function start() {
    if (instanceName === null || composition.length === 0) return;
    const temperatureValue =
      typeof temperature === "number" ? temperature : null;
    const seedValue = typeof seed === "number" ? seed : null;
    const sampling = {
      ...(temperatureValue !== null ? { temperature: temperatureValue } : {}),
      ...(seedValue !== null ? { seed: seedValue } : {}),
    };
    const scenario: BenchmarkScenarioInput = {
      target: { kind: "instance", instanceName },
      mode,
      composition,
      repetitions: mode === "sustained" ? 1 : repetitions,
      ...(mode === "sustained" ? { totalRequests } : {}),
      requestTimeoutMs: timeoutSeconds * 1000,
      warmup,
      cacheBust,
      ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
    };
    fm.startRun(scenario);
  }

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Title order={4}>New run</Title>
          <Button
            variant="light"
            size="xs"
            leftSection={<Plus size={14} />}
            onClick={() => fm.setPromptModalOpened(true)}
          >
            Custom prompt
          </Button>
        </Group>

        <TouchSelect
          label="Instance"
          placeholder="Select a running instance"
          data={instanceOptions}
          value={instanceName}
          onChange={setInstanceName}
          searchable
          filter={substringOptionsFilter}
        />

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Prompt mix
          </Text>
          {rows.map((row) => (
            <Group key={row.uiId} gap="xs" wrap="nowrap" align="flex-end">
              <TouchSelect
                placeholder="Prompt"
                data={promptOptions}
                value={row.promptId}
                onChange={(value) => updateRow(row.uiId, { promptId: value })}
                searchable
                filter={substringOptionsFilter}
                style={{ flex: 1 }}
              />
              <NumberInput
                w={90}
                label={mode === "sustained" ? "Clients" : "Copies"}
                min={1}
                max={64}
                value={row.count}
                onChange={(value) =>
                  updateRow(row.uiId, { count: asCount(value) })
                }
                aria-label={
                  mode === "sustained" ? "Concurrent clients" : "Prompt copies"
                }
              />
              <Tooltip label="Remove row">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  disabled={rows.length === 1}
                  onClick={() =>
                    setRows((current) =>
                      current.filter((entry) => entry.uiId !== row.uiId),
                    )
                  }
                >
                  <Trash2 size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
          <Button
            variant="subtle"
            size="xs"
            leftSection={<Plus size={14} />}
            onClick={() => setRows((current) => [...current, newRow()])}
            disabled={rows.length >= 32}
          >
            Add prompt
          </Button>
        </Stack>

        <Group gap="md" wrap="wrap" align="flex-end">
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Mode
            </Text>
            <SegmentedControl
              value={mode}
              onChange={(value) =>
                setMode(
                  value === "sustained"
                    ? "sustained"
                    : value === "sequential"
                      ? "sequential"
                      : "parallel",
                )
              }
              data={[
                { value: "parallel", label: "Parallel" },
                { value: "sequential", label: "Sequential" },
                { value: "sustained", label: "Sustained" },
              ]}
            />
          </Stack>
          {mode === "sustained" ? (
            <NumberInput
              label="Total requests"
              w={150}
              min={Math.max(1, clients)}
              max={100000}
              value={totalRequests}
              onChange={(value) => setTotalRequests(asCount(value))}
              error={
                totalRequests < clients ? "Must cover every client" : undefined
              }
            />
          ) : (
            <NumberInput
              label="Repetitions"
              w={110}
              min={1}
              max={20}
              value={repetitions}
              onChange={(value) => setRepetitions(asCount(value))}
            />
          )}
          <TextInput
            label="Label"
            placeholder="e.g. draft-on"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            style={{ flex: 1, minWidth: 140 }}
          />
        </Group>

        {mode === "sustained" && (
          <Text size="sm" c="dimmed">
            {countLabel(clients, "client")} continuously send independent
            requests. Each client repeats its prompt as soon as its previous
            request finishes, until the shared request limit is reached.
          </Text>
        )}

        <Group gap="md" wrap="wrap" align="flex-end">
          <Switch
            label="Warmup request"
            checked={warmup}
            onChange={(event) => setWarmup(event.currentTarget.checked)}
          />
          <Switch
            label="Bust prefix cache"
            checked={cacheBust}
            onChange={(event) => setCacheBust(event.currentTarget.checked)}
          />
          <NumberInput
            label="Temperature"
            w={120}
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={setTemperature}
          />
          <NumberInput label="Seed" w={120} value={seed} onChange={setSeed} />
          <NumberInput
            label="Request timeout (s)"
            w={160}
            min={1}
            max={3600}
            value={timeoutSeconds}
            onChange={(value) => setTimeoutSeconds(asCount(value))}
          />
        </Group>

        <Group justify="flex-end">
          <Button
            leftSection={<Play size={16} />}
            onClick={start}
            disabled={!canStart}
            loading={fm.startPending}
          >
            Start benchmark
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
