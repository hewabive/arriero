import type { SourceRepositoryOperationJob } from "@arriero/core";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  cancelSourceRepositoryOperation,
  getSourceRepositoryOperation,
} from "../../api/client";
import { notifyError } from "../utils/notify";

export function sourceOperationQueryKey(sourceId: string) {
  return ["source-repository-operation", sourceId] as const;
}

export async function invalidateSourceQueries(
  queryClient: QueryClient,
  sourceId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["source-repositories"] }),
    queryClient.invalidateQueries({
      queryKey: ["source-repository-status", sourceId],
    }),
    queryClient.invalidateQueries({
      queryKey: ["source-repository-drift", sourceId],
    }),
    queryClient.invalidateQueries({ queryKey: ["llama-source-refs"] }),
    queryClient.invalidateQueries({ queryKey: ["build-settings"] }),
    queryClient.invalidateQueries({ queryKey: ["llama-arg-docs-sync"] }),
    queryClient.invalidateQueries({ queryKey: ["llama-arg-help-diff"] }),
  ]);
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
    void invalidateSourceQueries(queryClient, sourceId);
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
    onError: notifyError("Cancel failed"),
  });

  return {
    job,
    running: job?.status === "running",
    setJob,
    cancelMutation,
  };
}
