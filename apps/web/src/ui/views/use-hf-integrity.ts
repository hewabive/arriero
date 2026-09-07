import type { HfIntegrityJob } from "@arriero/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  cancelHfIntegrityCheck,
  getHfIntegrityCheck,
  startHfIntegrityCheck,
} from "../../api/hf";
import { notifyError } from "../utils/notify";

export function useHfIntegrity(dir: string | null) {
  const client = useQueryClient();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notified = useRef<string | null>(null);
  const key = ["hf-integrity", dir];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getHfIntegrityCheck(dir!),
    enabled: dir !== null,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.data?.status === "running" ? 500 : 3000,
  });
  const job = query.data?.data ?? null;
  const accept = (result: { data: HfIntegrityJob }) => {
    client.setQueryData(key, result);
  };
  const start = useMutation({
    mutationFn: () => startHfIntegrityCheck(dir!),
    onSuccess: accept,
    onError: notifyError("Verify files"),
  });
  const cancel = useMutation({
    mutationFn: () => cancelHfIntegrityCheck(job!.id),
    onSuccess: accept,
    onError: notifyError("Cancel verification"),
  });
  useEffect(() => {
    if (!job || job.status !== "succeeded" || notified.current === job.id)
      return;
    notified.current = job.id;
    for (const name of ["hf-downloads", "hf-library"])
      void client.invalidateQueries({ queryKey: [name] });
  }, [job, client]);
  return {
    job,
    start,
    cancel,
    busy: job?.status === "running" || start.isPending,
    result: job?.id !== dismissed ? (job?.result ?? null) : null,
    error: query.error?.message ?? job?.error ?? null,
    clear: () => setDismissed(job?.id ?? null),
  };
}
