import type {
  BenchmarkPromptCreate,
  BenchmarkScenarioInput,
} from "@arriero/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  cancelBenchmarkRun,
  createBenchmarkPrompt,
  deleteBenchmarkPrompt,
  deleteBenchmarkRun,
  getBenchmarkRunResult,
  listBenchmarkPrompts,
  listBenchmarkRuns,
  listInstances,
  startBenchmarkRun,
} from "../../api/client";
import { notifyError } from "../utils/notify";

export function useBenchmarkView() {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [promptModalOpened, setPromptModalOpened] = useState(false);

  const instancesQuery = useQuery({
    queryKey: ["instances"],
    queryFn: listInstances,
    staleTime: 10_000,
  });
  const promptsQuery = useQuery({
    queryKey: ["benchmark-prompts"],
    queryFn: listBenchmarkPrompts,
    staleTime: 30_000,
  });
  const runsQuery = useQuery({
    queryKey: ["benchmark-runs"],
    queryFn: () => listBenchmarkRuns(50),
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => run.status === "running")
        ? 1_500
        : 10_000,
  });

  const runs = runsQuery.data?.data ?? [];
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  const resultQuery = useQuery({
    queryKey: ["benchmark-run-result", selectedRun?.id ?? ""],
    queryFn: () => getBenchmarkRunResult(selectedRun?.id ?? ""),
    enabled: Boolean(selectedRun && selectedRun.status !== "running"),
    retry: false,
    staleTime: 60_000,
  });

  const invalidateRuns = () =>
    queryClient.invalidateQueries({ queryKey: ["benchmark-runs"] });
  const invalidatePrompts = () =>
    queryClient.invalidateQueries({ queryKey: ["benchmark-prompts"] });

  const startMutation = useMutation({
    mutationFn: (input: BenchmarkScenarioInput) => startBenchmarkRun(input),
    onSuccess: async (result) => {
      await invalidateRuns();
      setSelectedRunId(result.data.id);
      notifications.show({
        title: "Benchmark run started",
        message: result.data.id,
      });
    },
    onError: notifyError("Benchmark start failed"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelBenchmarkRun(id),
    onSuccess: () => invalidateRuns(),
    onError: notifyError("Cancel failed"),
  });

  const deleteRunMutation = useMutation({
    mutationFn: (id: string) => deleteBenchmarkRun(id),
    onSuccess: async (_result, id) => {
      if (selectedRunId === id) {
        setSelectedRunId(null);
      }
      await invalidateRuns();
    },
    onError: notifyError("Delete failed"),
  });

  const createPromptMutation = useMutation({
    mutationFn: (input: BenchmarkPromptCreate) => createBenchmarkPrompt(input),
    onSuccess: async (result) => {
      await invalidatePrompts();
      setPromptModalOpened(false);
      notifications.show({
        title: "Custom prompt saved",
        message: result.data.title,
      });
    },
    onError: notifyError("Prompt save failed"),
  });

  const deletePromptMutation = useMutation({
    mutationFn: (id: string) => deleteBenchmarkPrompt(id),
    onSuccess: () => invalidatePrompts(),
    onError: notifyError("Prompt delete failed"),
  });

  return {
    instances: instancesQuery.data?.data ?? [],
    prompts: promptsQuery.data?.data ?? [],
    runs,
    selectedRun,
    selectRun: setSelectedRunId,
    result: resultQuery.data?.data ?? null,
    resultLoading: resultQuery.isLoading && resultQuery.fetchStatus !== "idle",
    promptModalOpened,
    setPromptModalOpened,
    startRun: (input: BenchmarkScenarioInput) => startMutation.mutate(input),
    startPending: startMutation.isPending,
    cancelRun: (id: string) => cancelMutation.mutate(id),
    deleteRun: (id: string) => deleteRunMutation.mutate(id),
    createPrompt: (input: BenchmarkPromptCreate) =>
      createPromptMutation.mutate(input),
    createPromptPending: createPromptMutation.isPending,
    deletePrompt: (id: string) => deletePromptMutation.mutate(id),
  };
}

export type BenchmarkViewController = ReturnType<typeof useBenchmarkView>;
