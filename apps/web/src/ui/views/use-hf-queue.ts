import type { HfDownloadQueueJob, HfDownloadQueueState } from "@arriero/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  cancelHfDownloadJob,
  clearHfDownloadHistory,
  getHfDownloadQueue,
  removeHfDownloadJob,
  reorderHfDownloadQueue,
  skipHfDownloadFiles,
} from "../../api/client";
import {
  currentByteRate,
  dropByteRate,
  recordRateSample,
  type ByteRate,
} from "../utils/byte-rate";

const QUEUE_QUERY_KEY = ["hf-queue"] as const;

export function useHfQueueQuery() {
  return useQuery({
    queryKey: QUEUE_QUERY_KEY,
    queryFn: getHfDownloadQueue,
    refetchInterval: (current) => {
      const data = current.state.data?.data;
      return data && (data.active !== null || data.queued.length > 0)
        ? 1_500
        : 5_000;
    },
  });
}

export function useHfJobsSync(): void {
  const queryClient = useQueryClient();
  const query = useHfQueueQuery();
  const data = query.data?.data ?? null;
  const seenRef = useRef(new Map<string, { status: string; done: number }>());
  const lastListInvalidateRef = useRef(0);

  useEffect(() => {
    if (!data) {
      return;
    }
    const seen = seenRef.current;
    const jobs = [
      ...(data.active ? [data.active] : []),
      ...data.queued,
      ...data.history,
    ];
    let settled = false;
    for (const job of jobs) {
      const previous = seen.get(job.id);
      const done = job.files.filter(
        (file) => file.status === "succeeded",
      ).length;
      const terminal =
        job.status === "succeeded" ||
        job.status === "failed" ||
        job.status === "canceled";
      if (terminal && previous && previous.status !== job.status) {
        settled = true;
        dropByteRate(job.id);
      }
      if (!terminal && previous && done > previous.done) {
        const now = Date.now();
        if (now - lastListInvalidateRef.current > 10_000) {
          lastListInvalidateRef.current = now;
          void queryClient.invalidateQueries({ queryKey: ["hf-downloads"] });
        }
      }
      seen.set(job.id, { status: job.status, done });
    }
    if (settled) {
      void queryClient.invalidateQueries({ queryKey: ["hf-downloads"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    }
  }, [data, queryClient]);
}

export function useHfQueue() {
  const queryClient = useQueryClient();
  const query = useHfQueueQuery();
  const state: HfDownloadQueueState | null = query.data?.data ?? null;
  const active = state?.active ?? null;
  const queued = state?.queued ?? [];
  const history = state?.history ?? [];

  const activeId = active?.id ?? null;
  const activeBytes = active?.downloadedBytes ?? null;
  useEffect(() => {
    if (activeId === null || activeBytes === null) {
      return;
    }
    recordRateSample(activeId, activeBytes, Date.now());
  }, [activeId, activeBytes]);
  const rate: ByteRate = activeId
    ? currentByteRate(activeId, Date.now())
    : { bps: null, stalled: false };

  const apply = (result: { data: HfDownloadQueueState }) => {
    queryClient.setQueryData(QUEUE_QUERY_KEY, result);
  };
  const reportError = (title: string) => (error: unknown) => {
    notifications.show({
      color: "red",
      title,
      message: (error as Error).message,
    });
    void queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
  };

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => cancelHfDownloadJob(jobId),
    onSuccess: apply,
    onError: reportError("Cancel download"),
  });
  const removeMutation = useMutation({
    mutationFn: (jobId: string) => removeHfDownloadJob(jobId),
    onSuccess: apply,
    onError: reportError("Remove download"),
  });
  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => reorderHfDownloadQueue(ids),
    onSuccess: apply,
    onError: reportError("Reorder queue"),
  });
  const skipMutation = useMutation({
    mutationFn: (input: { jobId: string; paths: string[] }) =>
      skipHfDownloadFiles(input.jobId, input.paths),
    onSuccess: apply,
    onError: reportError("Skip files"),
  });
  const clearMutation = useMutation({
    mutationFn: () => clearHfDownloadHistory(),
    onSuccess: apply,
    onError: reportError("Clear history"),
  });

  const move = (jobId: string, direction: "up" | "down") => {
    const ids = queued.map((job) => job.id);
    const index = ids.indexOf(jobId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= ids.length) {
      return;
    }
    const next = [...ids];
    const swapped = next[target];
    if (swapped === undefined) {
      return;
    }
    next[target] = jobId;
    next[index] = swapped;
    reorderMutation.mutate(next);
  };

  return {
    state,
    active,
    queued,
    history,
    rate,
    cancel: (jobId: string) => cancelMutation.mutate(jobId),
    remove: (jobId: string) => removeMutation.mutate(jobId),
    move,
    skipFiles: (jobId: string, paths: string[]) =>
      skipMutation.mutate({ jobId, paths }),
    clearHistory: () => clearMutation.mutate(),
    pending: {
      cancelId: cancelMutation.isPending ? cancelMutation.variables : null,
      removeId: removeMutation.isPending ? removeMutation.variables : null,
      reorder: reorderMutation.isPending,
      skip: skipMutation.isPending ? skipMutation.variables : null,
      clear: clearMutation.isPending,
    },
  };
}
