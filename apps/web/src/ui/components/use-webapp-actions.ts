import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { restartWebapp, startWebapp, stopWebapp } from "../../api/client";
import { notifyError } from "../utils/notify";

export function useInvalidateWebapps() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0]).startsWith("webapp"),
    });
}

export type WebappActions = {
  start: UseMutationResult<unknown, unknown, string>;
  stop: UseMutationResult<unknown, unknown, string>;
  restart: UseMutationResult<unknown, unknown, string>;
  pending: boolean;
};

export function useWebappActions(): WebappActions {
  const invalidate = useInvalidateWebapps();
  const start = useMutation({
    mutationFn: startWebapp,
    onSuccess: invalidate,
    onError: notifyError("Start failed"),
  });
  const stop = useMutation({
    mutationFn: stopWebapp,
    onSuccess: invalidate,
    onError: notifyError("Stop failed"),
  });
  const restart = useMutation({
    mutationFn: restartWebapp,
    onSuccess: invalidate,
    onError: notifyError("Restart failed"),
  });
  return {
    start,
    stop,
    restart,
    pending: start.isPending || stop.isPending || restart.isPending,
  };
}
