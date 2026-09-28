import {
  BENCHMARK_REPLAY_DEFAULT_OUTPUT_CEILING,
  type BenchmarkContextFit,
  type BenchmarkReplayArrival,
  type BenchmarkReplayPriming,
  type BenchmarkReplayScenarioInput,
  type BenchmarkReplayThinkTime,
  type WorkloadDatasetDetail,
} from "@arriero/core";
import {
  Alert,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, Ruler } from "lucide-react";

import {
  getBenchmarkContextFit,
  getBenchmarkReservationPreview,
} from "../../api/client";
import {
  TouchSelect,
  substringOptionsFilter,
} from "../components/TouchCombobox";
import { notifyError } from "../utils/notify";
import { countLabel } from "../utils/plural";
import {
  workloadDatasetQuery,
  workloadDatasetsQuery,
} from "../workload/workload-dataset-queries";
import { formatDurationMs } from "./benchmark-format";

export type ReplayFormState = {
  datasetId: string | null;
  arrival: BenchmarkReplayArrival["kind"];
  intervalSeconds: number;
  concurrencyCap: number | string;
  thinkTime: BenchmarkReplayThinkTime["kind"];
  thinkFactor: number;
  thinkCapSeconds: number;
  priming: BenchmarkReplayPriming;
  idleSkipping: boolean;
  outputCeiling: number;
  imitateClientAborts: boolean;
};

export const defaultReplayForm: ReplayFormState = {
  datasetId: null,
  arrival: "recorded",
  intervalSeconds: 5,
  concurrencyCap: "",
  thinkTime: "recorded",
  thinkFactor: 0.5,
  thinkCapSeconds: 10,
  priming: "recorded",
  idleSkipping: true,
  outputCeiling: BENCHMARK_REPLAY_DEFAULT_OUTPUT_CEILING,
  imitateClientAborts: false,
};

type ReplayScenarioFields = Pick<
  BenchmarkReplayScenarioInput,
  | "datasetId"
  | "arrival"
  | "thinkTime"
  | "priming"
  | "idleSkipping"
  | "outputCeiling"
  | "imitateClientAborts"
>;

function arrivalInput(
  state: ReplayFormState,
): BenchmarkReplayScenarioInput["arrival"] {
  const concurrencyCap =
    typeof state.concurrencyCap === "number" ? state.concurrencyCap : null;
  switch (state.arrival) {
    case "recorded":
      return { kind: "recorded" };
    case "together":
      return { kind: "together", concurrencyCap };
    case "interval":
      return {
        kind: "interval",
        intervalMs: Math.round(state.intervalSeconds * 1000),
        concurrencyCap,
      };
  }
}

function thinkTimeInput(
  state: ReplayFormState,
): BenchmarkReplayScenarioInput["thinkTime"] {
  switch (state.thinkTime) {
    case "recorded":
      return { kind: "recorded" };
    case "scaled":
      return { kind: "scaled", factor: state.thinkFactor };
    case "capped":
      return {
        kind: "capped",
        maxMs: Math.round(state.thinkCapSeconds * 1000),
      };
    case "none":
      return { kind: "none" };
  }
}

export function replayScenarioFields(
  state: ReplayFormState,
): ReplayScenarioFields | null {
  if (state.datasetId === null) {
    return null;
  }
  return {
    datasetId: state.datasetId,
    arrival: arrivalInput(state),
    thinkTime: thinkTimeInput(state),
    priming: state.priming,
    idleSkipping: state.idleSkipping,
    outputCeiling: state.outputCeiling,
    imitateClientAborts: state.imitateClientAborts,
  };
}

export function replayPlanProblem(
  state: ReplayFormState,
  detail: WorkloadDatasetDetail | null,
): string | null {
  const windows = detail?.summary.windows.length ?? 0;
  return state.arrival === "recorded" && windows > 1
    ? `The recorded plan replays one window, and this dataset holds ${windows}. Choose Together or Interval.`
    : null;
}

function recordedPacingMs(
  state: ReplayFormState,
  detail: WorkloadDatasetDetail,
): number | null {
  const segments = detail.segments;
  const windowStart = Date.parse(detail.summary.windows[0]?.from ?? "");
  const spans = segments.map(
    (segment) => Date.parse(segment.lastEndAt) - Date.parse(segment.firstAt),
  );
  if (segments.length === 0 || spans.some((span) => !Number.isFinite(span))) {
    return null;
  }
  switch (state.arrival) {
    case "recorded":
      return Number.isFinite(windowStart)
        ? Math.max(
            ...segments.map(
              (segment) => Date.parse(segment.lastEndAt) - windowStart,
            ),
          )
        : null;
    case "together":
      return Math.max(...spans);
    case "interval":
      return Math.max(
        ...spans.map(
          (span, index) => index * state.intervalSeconds * 1000 + span,
        ),
      );
  }
}

function ContextFitResult({ fit }: { fit: BenchmarkContextFit }) {
  const overflow = fit.segments.filter((segment) => segment.fits === false);
  const unknown = fit.segments.filter((segment) => segment.fits === null);
  return (
    <Alert
      color={
        overflow.length > 0 ? "red" : unknown.length > 0 ? "yellow" : "teal"
      }
      icon={<Ruler size={16} />}
      title={
        overflow.length > 0
          ? `${countLabel(overflow.length, "segment")} exceed the context`
          : unknown.length > 0
            ? "Context fit is partly unknown"
            : "Every segment fits the context"
      }
    >
      <Stack gap={2}>
        <Text size="sm">
          Context{" "}
          {fit.contextTokens === null
            ? "unknown"
            : `${fit.contextTokens.toLocaleString()} tokens`}{" "}
          · output ceiling {fit.outputCeiling.toLocaleString()} tokens
        </Text>
        {overflow.map((segment) => (
          <Text key={segment.sessionId} size="sm">
            {segment.sessionId}: {segment.promptTokens?.toLocaleString()} prompt
            tokens
          </Text>
        ))}
        {fit.warnings.map((warning) => (
          <Text key={warning} size="sm" c="dimmed">
            {warning}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}

export function BenchmarkReplayFields(props: {
  state: ReplayFormState;
  onChange: (patch: Partial<ReplayFormState>) => void;
  instanceName: string | null;
  detail: WorkloadDatasetDetail | null;
}) {
  const { state, onChange, instanceName, detail } = props;
  const datasetsQuery = useQuery({
    ...workloadDatasetsQuery,
    staleTime: 30_000,
  });
  const previewQuery = useQuery({
    queryKey: ["benchmark-reservation-preview", instanceName],
    queryFn: () => getBenchmarkReservationPreview(instanceName ?? ""),
    enabled: instanceName !== null,
    staleTime: 10_000,
  });
  const fitMutation = useMutation({
    mutationFn: getBenchmarkContextFit,
    onError: notifyError("Context check failed"),
  });
  const datasets = datasetsQuery.data?.data ?? [];
  const datasetOptions = datasets.map((dataset) => ({
    value: dataset.id,
    label: `${dataset.name} · ${countLabel(dataset.segments, "segment")} · ${countLabel(dataset.records, "request")}`,
  }));
  const preview = previewQuery.data?.data ?? null;
  const pacingMs = detail ? recordedPacingMs(state, detail) : null;
  const planProblem = replayPlanProblem(state, detail);
  const composed = state.arrival !== "recorded";
  const fit =
    fitMutation.data?.data &&
    fitMutation.variables?.dataset === state.datasetId &&
    fitMutation.variables.instance === instanceName
      ? fitMutation.data.data
      : null;

  return (
    <Stack gap="sm">
      <TouchSelect
        label="Dataset"
        placeholder={
          datasets.length === 0
            ? "Freeze a dataset under Proxy → Workload first"
            : "Select a frozen dataset"
        }
        data={datasetOptions}
        value={state.datasetId}
        onChange={(value) => onChange({ datasetId: value })}
        searchable
        filter={substringOptionsFilter}
      />
      {detail && (
        <Text size="xs" c="dimmed">
          {detail.summary.id.slice(0, 12)} ·{" "}
          {countLabel(detail.summary.windows.length, "window")} ·{" "}
          {countLabel(detail.summary.primedSegments, "primed segment")}
          {pacingMs !== null
            ? ` · up to ${formatDurationMs(pacingMs)} at recorded pacing`
            : ""}
        </Text>
      )}

      <Group gap="md" wrap="wrap" align="flex-end">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Arrival
          </Text>
          <SegmentedControl
            value={state.arrival}
            onChange={(arrival) => onChange({ arrival })}
            data={[
              { value: "recorded", label: "Recorded" },
              { value: "together", label: "Together" },
              { value: "interval", label: "Interval" },
            ]}
          />
        </Stack>
        {state.arrival === "interval" && (
          <NumberInput
            label="Interval (s)"
            w={120}
            min={0}
            max={3600}
            step={0.5}
            value={state.intervalSeconds}
            onChange={(value) =>
              onChange({
                intervalSeconds: typeof value === "number" ? value : 0,
              })
            }
          />
        )}
        {composed && (
          <NumberInput
            label="Concurrency cap"
            placeholder="none"
            w={140}
            min={1}
            max={256}
            value={state.concurrencyCap}
            onChange={(value) => onChange({ concurrencyCap: value })}
          />
        )}
      </Group>
      {planProblem && (
        <Text size="sm" c="red">
          {planProblem}
        </Text>
      )}
      {composed && !planProblem && (
        <Text size="xs" c="dimmed">
          A composed plan starts the segments as if they ran together — load
          that never occurred, so no fidelity report is produced.
        </Text>
      )}

      <Group gap="md" wrap="wrap" align="flex-end">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Think time
          </Text>
          <SegmentedControl
            value={state.thinkTime}
            onChange={(thinkTime) => onChange({ thinkTime })}
            data={[
              { value: "recorded", label: "Recorded" },
              { value: "scaled", label: "Scaled" },
              { value: "capped", label: "Capped" },
              { value: "none", label: "None" },
            ]}
          />
        </Stack>
        {state.thinkTime === "scaled" && (
          <NumberInput
            label="Factor"
            w={100}
            min={0}
            max={100}
            step={0.1}
            value={state.thinkFactor}
            onChange={(value) =>
              onChange({ thinkFactor: typeof value === "number" ? value : 1 })
            }
          />
        )}
        {state.thinkTime === "capped" && (
          <NumberInput
            label="Cap (s)"
            w={100}
            min={0}
            max={86400}
            value={state.thinkCapSeconds}
            onChange={(value) =>
              onChange({
                thinkCapSeconds: typeof value === "number" ? value : 0,
              })
            }
          />
        )}
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Priming
          </Text>
          <SegmentedControl
            value={state.priming}
            onChange={(priming) => onChange({ priming })}
            data={[
              { value: "recorded", label: "Recorded" },
              { value: "all", label: "All" },
              { value: "none", label: "None" },
            ]}
          />
        </Stack>
      </Group>

      <Group gap="md" wrap="wrap" align="flex-end">
        <NumberInput
          label="Output ceiling (tokens)"
          w={180}
          min={1}
          max={262144}
          value={state.outputCeiling}
          onChange={(value) =>
            onChange({
              outputCeiling:
                typeof value === "number" && value >= 1 ? Math.floor(value) : 1,
            })
          }
        />
        <Switch
          label="Skip idle time"
          checked={state.idleSkipping}
          onChange={(event) =>
            onChange({ idleSkipping: event.currentTarget.checked })
          }
        />
        <Switch
          label="Imitate client aborts"
          checked={state.imitateClientAborts}
          onChange={(event) =>
            onChange({ imitateClientAborts: event.currentTarget.checked })
          }
        />
      </Group>

      {preview && (
        <Alert
          color={preview.drawsDeclared ? "blue" : "yellow"}
          icon={<CircleAlert size={16} />}
          title="The proxy is blocked for the run"
        >
          <Stack gap={2}>
            <Text size="sm">
              Reserved instances: {preview.instanceNames.join(", ")}
            </Text>
            <Text size="sm">
              {preview.targetNames.length > 0
                ? `Requests to ${preview.targetNames.join(", ")} get HTTP 503 until the run ends.`
                : "No proxy target points at these instances."}
            </Text>
            {!preview.drawsDeclared && (
              <Text size="sm">
                The instance declares no memory-pool draws, so neighbors on the
                same hardware are unknown and keep serving.
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      <Group gap="sm" align="flex-start" wrap="wrap">
        <Button
          variant="light"
          size="xs"
          leftSection={<Ruler size={14} />}
          disabled={state.datasetId === null || instanceName === null}
          loading={fitMutation.isPending}
          onClick={() => {
            if (state.datasetId === null || instanceName === null) return;
            fitMutation.mutate({
              dataset: state.datasetId,
              instance: instanceName,
              outputCeiling: state.outputCeiling,
            });
          }}
        >
          Check context fit
        </Button>
      </Group>
      {fit && <ContextFitResult fit={fit} />}
    </Stack>
  );
}

export function useReplayDatasetDetail(datasetId: string | null) {
  const query = useQuery({
    ...workloadDatasetQuery(datasetId ?? ""),
    enabled: datasetId !== null,
    staleTime: 60_000,
  });
  return query.data?.data ?? null;
}
