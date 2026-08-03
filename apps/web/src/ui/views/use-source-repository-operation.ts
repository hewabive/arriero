import type { SourceRepositoryOperationJob } from "@arriero/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  cancelSourceRepositoryOperation,
  getSourceRepositoryOperation,
} from "../../api/client";

function sourceOperationQueryKey(sourceId: string) {
  return ["source-repository-operation", sourceId] as const;
}

export function useSourceRepositoryOperation(sourceId: string) {
  const queryClient = useQueryClient();
  const completionRef = useRef<string | null>(null);
  const query = useQuery({
    queryKey: sourceOperationQueryKey(sourceId),
    queryFn: () => getSourceRepositoryOperation(sourceId),
    refetchInterval: (current) =>
      current.state.data?.data?.status === "running" ? 750 : 5_000,
  });
  const job = query.data?.data ?? null;

  useEffect(() => {
    if (!job || job.status === "running") return;
    const completion = `${job.id}:${job.status}`;
    if (completionRef.current === completion) return;
    completionRef.current = completion;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["source-repositories"] }),
      queryClient.invalidateQueries({
        queryKey: ["source-repository-status", sourceId],
      }),
      queryClient.invalidateQueries({ queryKey: ["llama-source-status"] }),
      queryClient.invalidateQueries({ queryKey: ["llama-source-refs"] }),
      queryClient.invalidateQueries({ queryKey: ["build-settings"] }),
      queryClient.invalidateQueries({
        queryKey: ["source-repository-drift", sourceId],
      }),
    ]);
  }, [job, queryClient, sourceId]);

  const setJob = useCallback(
    (next: SourceRepositoryOperationJob) => {
      queryClient.setQueryData(sourceOperationQueryKey(sourceId), {
        data: next,
      });
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["source-repositories"] }),
        queryClient.invalidateQueries({
          queryKey: ["source-repository-status", sourceId],
        }),
      ]);
    },
    [queryClient, sourceId],
  );

  const cancelMutation = useMutation({
    mutationFn: () => cancelSourceRepositoryOperation(sourceId),
    onSuccess: (response) => setJob(response.data),
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Cancel failed",
        message: (error as Error).message,
      });
    },
  });

  return {
    query,
    job,
    running: job?.status === "running",
    setJob,
    cancelMutation,
  };
}
