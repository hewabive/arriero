import type {
  InstanceHealthSummary,
  EndpointProbe,
  LlamaModelDiagnostics,
} from "@arriero/core";
import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Play, Power, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { pathBaseName } from "../utils/models";
import {
  type RouterModelAction,
  type SlotActionInput,
  type SlotRow,
  fallbackModelLoadProgress,
  formatBytes,
  formatCompactCount,
  formatInteger,
  isModelLoading,
  isRouterModelStatus,
  jsonValuePreview,
  loadProgressColor,
  loadProgressValue,
  loraAdaptersFromProbe,
  loraRuntimeSummary,
  metricsRuntimeSummary,
  modelCanLoad,
  modelCanUnload,
  modelLoadProgress,
  modelStatusColor,
  numberValue,
  probeColor,
  propsRuntimeSummary,
  slotFilenameBase,
  slotRowsFromProbe,
  slotsRuntimeSummary,
  v1ModelsFromProbe,
} from "./instance-details-helpers";

export function SlotDetailsBlock(props: {
  rows: SlotRow[];
  model: string | null;
  pendingAction: SlotActionInput | null;
  onSlotAction: (input: SlotActionInput) => void;
}) {
  const [filenames, setFilenames] = useState<Record<string, string>>({});

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs" mt={4}>
      {props.rows.map((slot) => {
        const filename =
          filenames[slot.id] ?? slotFilenameBase(props.model, slot.id);
        const pending =
          props.pendingAction?.slotId === slot.idNumber &&
          props.pendingAction.model === props.model
            ? props.pendingAction.action
            : null;
        const actionInFlight = props.pendingAction !== null;
        const canAct = slot.idNumber !== null;

        return (
          <Paper key={slot.id} withBorder p="xs" radius="sm">
            <Group justify="space-between" gap="xs">
              <Text fw={600} size="xs">
                slot {slot.id}
              </Text>
              <Badge color={slot.busy ? "yellow" : "green"} size="xs">
                {slot.busy ? "busy" : "idle"}
              </Badge>
            </Group>
            <Text c="dimmed" size="xs" mt={4}>
              task {slot.taskId} · ctx {slot.nCtx} · decoded {slot.decoded} ·
              remain {slot.remain} · prompt {slot.promptTokens}/
              {slot.promptProcessed} · cache {slot.promptCache}
              {slot.speculative ? " · speculative" : ""}
            </Text>
            <Group gap="xs" mt="xs" align="flex-end">
              <TextInput
                label="State file"
                size="xs"
                value={filename}
                className="min-w-0"
                style={{ flex: "1 1 180px" }}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setFilenames((current) => ({
                    ...current,
                    [slot.id]: value,
                  }));
                }}
              />
              <Button
                size="xs"
                variant="light"
                leftSection={<Save size={14} />}
                loading={pending === "save"}
                disabled={!canAct || !filename.trim() || actionInFlight}
                onClick={() =>
                  props.onSlotAction({
                    model: props.model,
                    slotId: slot.idNumber!,
                    action: "save",
                    filename,
                  })
                }
              >
                Save
              </Button>
              <Button
                size="xs"
                variant="light"
                leftSection={<RotateCcw size={14} />}
                loading={pending === "restore"}
                disabled={!canAct || !filename.trim() || actionInFlight}
                onClick={() =>
                  props.onSlotAction({
                    model: props.model,
                    slotId: slot.idNumber!,
                    action: "restore",
                    filename,
                  })
                }
              >
                Restore
              </Button>
              <Button
                size="xs"
                variant="light"
                color="red"
                leftSection={<Trash2 size={14} />}
                loading={pending === "erase"}
                disabled={!canAct || actionInFlight}
                onClick={() => {
                  if (!window.confirm(`Erase slot ${slot.id} cache?`)) {
                    return;
                  }
                  props.onSlotAction({
                    model: props.model,
                    slotId: slot.idNumber!,
                    action: "erase",
                  });
                }}
              >
                Erase
              </Button>
            </Group>
          </Paper>
        );
      })}
    </SimpleGrid>
  );
}

function RuntimeProbeLine(props: {
  label: string;
  probe: EndpointProbe | undefined;
  summary: string;
}) {
  return (
    <Paper withBorder p="xs" radius="sm">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text fw={600} size="xs">
          {props.label}
        </Text>
        <Badge color={probeColor(props.probe)} variant="light" size="xs">
          {props.probe?.status ?? "offline"}
        </Badge>
      </Group>
      <Text c={props.probe?.ok ? "dimmed" : "red"} size="xs" mt={4}>
        {props.summary}
      </Text>
    </Paper>
  );
}

export function V1ModelsPanel(props: {
  probe: EndpointProbe | undefined;
  modelDiagnostics: Record<string, LlamaModelDiagnostics>;
  statusSummary: InstanceHealthSummary["logSummary"] | undefined;
  onReload: () => void;
  reloadPending: boolean;
  onModelAction: (model: string, action: RouterModelAction) => void;
  pendingAction: { model: string; action: RouterModelAction } | null;
  onSlotAction: (input: SlotActionInput) => void;
  pendingSlotAction: SlotActionInput | null;
}) {
  const models = v1ModelsFromProbe(props.probe);
  const body = props.probe?.body;
  const loadedCount = models.filter(
    (model) => model.status?.toLowerCase() === "loaded",
  ).length;
  const unexpectedBody =
    props.probe?.ok &&
    models.length === 0 &&
    body !== undefined &&
    body !== null
      ? jsonValuePreview(body)
      : null;

  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" mb="xs">
        <Stack gap={2}>
          <Text fw={600} size="sm">
            Models API
          </Text>
          <Text c="dimmed" size="xs">
            Models exposed by `GET /v1/models`.
          </Text>
        </Stack>
        <Group gap="xs">
          <Button
            size="xs"
            variant="subtle"
            leftSection={<RefreshCw size={14} />}
            loading={props.reloadPending}
            disabled={!props.probe?.ok || props.reloadPending}
            onClick={props.onReload}
          >
            Reload list
          </Button>
          <Badge color={probeColor(props.probe)} variant="light">
            {props.probe?.ok
              ? `${models.length} total · ${loadedCount} loaded`
              : (props.probe?.status ?? "offline")}
          </Badge>
        </Group>
      </Group>

      {props.probe?.error && (
        <Text c="red" size="xs" mb="xs">
          {props.probe.error}
        </Text>
      )}

      <Stack gap="xs">
        {models.map((model) => {
          const runtime = props.modelDiagnostics[model.id];
          const loraAdapters = loraAdaptersFromProbe(runtime?.loraAdapters);
          const slotRows = slotRowsFromProbe(runtime?.slots);
          const progress =
            modelLoadProgress({
              model,
              models,
              statusSummary: props.statusSummary,
              pendingAction: props.pendingAction,
            }) ?? fallbackModelLoadProgress();

          return (
            <Paper key={model.id} withBorder p="xs" radius="sm">
              <Group justify="space-between" gap="xs" align="flex-start">
                <Stack gap={4} className="min-w-0">
                  <Group gap="xs">
                    <Text fw={600} size="sm" className="text-wrap">
                      {model.id}
                    </Text>
                    <Badge
                      color={modelStatusColor(model.status)}
                      variant="light"
                    >
                      {model.status ?? "unknown"}
                    </Badge>
                    {model.modalities && (
                      <Badge variant="outline" color="gray">
                        {model.modalities}
                      </Badge>
                    )}
                  </Group>
                  {model.modelPath && (
                    <Text
                      c="dimmed"
                      size="xs"
                      title={model.modelPath}
                      className="text-wrap"
                    >
                      {pathBaseName(model.modelPath)}
                    </Text>
                  )}
                </Stack>
                <Group gap="xs" justify="flex-end">
                  {isRouterModelStatus(model.status) && (
                    <>
                      <Button
                        size="xs"
                        variant="light"
                        color="green"
                        leftSection={<Play size={14} />}
                        loading={
                          props.pendingAction?.model === model.id &&
                          props.pendingAction.action === "load"
                        }
                        disabled={
                          !modelCanLoad(model.status) ||
                          props.pendingAction !== null
                        }
                        onClick={() => props.onModelAction(model.id, "load")}
                      >
                        Load
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        color="yellow"
                        leftSection={<Power size={14} />}
                        loading={
                          props.pendingAction?.model === model.id &&
                          props.pendingAction.action === "unload"
                        }
                        disabled={
                          !modelCanUnload(model.status) ||
                          props.pendingAction !== null
                        }
                        onClick={() => props.onModelAction(model.id, "unload")}
                      >
                        Unload
                      </Button>
                    </>
                  )}
                  {model.object && model.object !== "model" && (
                    <Badge variant="outline">{model.object}</Badge>
                  )}
                </Group>
              </Group>

              <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing={4} mt={8}>
                <Text size="xs">
                  Context:{" "}
                  <Text span c="dimmed">
                    {model.ctxSize ?? "-"}
                  </Text>
                </Text>
                <Text size="xs">
                  GPU layers:{" "}
                  <Text span c="dimmed">
                    {model.nGpuLayers ?? "-"}
                  </Text>
                </Text>
                <Text size="xs">
                  Startup:{" "}
                  <Text span c="dimmed">
                    {model.loadOnStartup ?? "-"}
                  </Text>
                </Text>
                <Text size="xs">
                  Stop timeout:{" "}
                  <Text span c="dimmed">
                    {model.stopTimeout ? `${model.stopTimeout}s` : "-"}
                  </Text>
                </Text>
                {model.failed && (
                  <Text size="xs" c="red">
                    Last exit:{" "}
                    <Text span c="red">
                      {model.exitCode ?? "failed"}
                    </Text>
                  </Text>
                )}
              </SimpleGrid>

              {isModelLoading(model.status) && (
                <Stack gap={4} mt="xs">
                  <Group justify="space-between">
                    <Text fw={600} size="xs">
                      Model load
                    </Text>
                    <Text c="dimmed" size="xs">
                      {progress.percent === null
                        ? progress.stage
                        : `${progress.percent}%`}
                    </Text>
                  </Group>
                  <Progress
                    animated={progress.stage !== "ready"}
                    striped
                    color={loadProgressColor(progress)}
                    radius="xs"
                    size="sm"
                    value={loadProgressValue(progress)}
                  />
                  <Text
                    c={progress.stage === "error" ? "red" : "dimmed"}
                    size="xs"
                  >
                    {progress.message}
                    {progress.estimated ? " Estimated from logs." : ""}
                  </Text>
                </Stack>
              )}

              {model.meta && (
                <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing={4} mt={8}>
                  <Text size="xs">
                    Parameters:{" "}
                    <Text span c="dimmed">
                      {formatCompactCount(model.meta.nParams) ?? "-"}
                    </Text>
                  </Text>
                  <Text size="xs">
                    Runtime size:{" "}
                    <Text span c="dimmed">
                      {formatBytes(model.meta.sizeBytes) ?? "-"}
                    </Text>
                  </Text>
                  <Text size="xs">
                    Loaded ctx:{" "}
                    <Text span c="dimmed">
                      {formatInteger(model.meta.nCtx) ?? "-"}
                    </Text>
                  </Text>
                  <Text size="xs">
                    Train ctx:{" "}
                    <Text span c="dimmed">
                      {formatInteger(model.meta.nCtxTrain) ?? "-"}
                    </Text>
                  </Text>
                  <Text size="xs">
                    Vocab:{" "}
                    <Text span c="dimmed">
                      {formatInteger(model.meta.nVocab) ?? "-"}
                    </Text>
                  </Text>
                  <Text size="xs">
                    Embedding:{" "}
                    <Text span c="dimmed">
                      {formatInteger(model.meta.nEmbd) ?? "-"}
                    </Text>
                  </Text>
                </SimpleGrid>
              )}

              {runtime && (
                <SimpleGrid cols={{ base: 1, md: 4 }} spacing="xs" mt={8}>
                  <RuntimeProbeLine
                    label="props"
                    probe={runtime.props}
                    summary={propsRuntimeSummary(runtime.props)}
                  />
                  <RuntimeProbeLine
                    label="slots"
                    probe={runtime.slots}
                    summary={slotsRuntimeSummary(runtime.slots)}
                  />
                  <RuntimeProbeLine
                    label="metrics"
                    probe={runtime.metrics}
                    summary={metricsRuntimeSummary(runtime.metrics)}
                  />
                  <RuntimeProbeLine
                    label="lora"
                    probe={runtime.loraAdapters}
                    summary={loraRuntimeSummary(runtime.loraAdapters)}
                  />
                </SimpleGrid>
              )}

              {slotRows.length > 0 && (
                <Box
                  component="details"
                  className="v1-model-diagnostics"
                  mt={8}
                >
                  <Text component="summary" c="dimmed" size="xs">
                    Slot details
                  </Text>
                  <SlotDetailsBlock
                    rows={slotRows}
                    model={model.id}
                    pendingAction={props.pendingSlotAction}
                    onSlotAction={props.onSlotAction}
                  />
                </Box>
              )}

              {loraAdapters.length > 0 && (
                <Group gap={4} mt={8}>
                  {loraAdapters.map((adapter, index) => {
                    const id = jsonValuePreview(adapter.id) ?? String(index);
                    const path = jsonValuePreview(adapter.path);
                    const scale = numberValue(adapter.scale);
                    return (
                      <Badge
                        key={`${id}-${path ?? index}`}
                        size="xs"
                        variant="light"
                        color={scale && scale > 0 ? "green" : "gray"}
                        title={path ?? undefined}
                      >
                        {path ? pathBaseName(path) : `adapter ${id}`} · scale{" "}
                        {scale ?? "-"}
                      </Badge>
                    );
                  })}
                </Group>
              )}

              {(model.aliases.length > 0 || model.tags.length > 0) && (
                <Group gap={4} mt={8}>
                  {model.aliases.map((alias) => (
                    <Badge key={`alias-${alias}`} size="xs" variant="light">
                      alias {alias}
                    </Badge>
                  ))}
                  {model.tags.map((tag) => (
                    <Badge
                      key={`tag-${tag}`}
                      size="xs"
                      color="grape"
                      variant="light"
                    >
                      tag {tag}
                    </Badge>
                  ))}
                </Group>
              )}

              <Group gap="xs" mt={8}>
                {model.created && (
                  <Text c="dimmed" size="xs">
                    Registered: {model.created}
                  </Text>
                )}
                {model.ownedBy && model.ownedBy !== "llamacpp" && (
                  <Text c="dimmed" size="xs">
                    Owner: {model.ownedBy}
                  </Text>
                )}
              </Group>

              {(model.diagnosticArgs.length > 0 ||
                model.diagnosticPreset ||
                model.unknownExtras.length > 0) && (
                <Box
                  component="details"
                  className="v1-model-diagnostics"
                  mt={8}
                >
                  <Text component="summary" c="dimmed" size="xs">
                    Diagnostics
                  </Text>
                  <Stack gap={4} mt={4}>
                    {model.diagnosticArgs.length > 0 && (
                      <Code block className="code-wrap">
                        {model.diagnosticArgs.join(" ")}
                      </Code>
                    )}
                    {model.diagnosticPreset && (
                      <Code block className="code-wrap">
                        {model.diagnosticPreset}
                      </Code>
                    )}
                    {model.unknownExtras.map(([key, value]) => (
                      <Text key={key} c="dimmed" size="xs" lineClamp={2}>
                        {key}: {value}
                      </Text>
                    ))}
                  </Stack>
                </Box>
              )}
            </Paper>
          );
        })}

        {!props.probe && (
          <Text c="dimmed" size="sm">
            Model list has not been probed yet.
          </Text>
        )}
        {props.probe?.ok && models.length === 0 && !unexpectedBody && (
          <Text c="dimmed" size="sm">
            Server returned an empty model list.
          </Text>
        )}
        {unexpectedBody && (
          <Code block className="code-wrap">
            {unexpectedBody}
          </Code>
        )}
      </Stack>
    </Paper>
  );
}
