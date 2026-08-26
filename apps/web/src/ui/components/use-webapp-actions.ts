import { notifications } from "@mantine/notifications";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { restartWebapp, startWebapp, stopWebapp } from "../../api/client";

export function webappErrorNotification(title: string) {
  return (error: unknown) =>
    notifications.show({
      color: "red",
      title,
      message: (error as Error).message,
    });
}

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
    onError: webappErrorNotification("Start failed"),
  });
  const stop = useMutation({
    mutationFn: stopWebapp,
    onSuccess: invalidate,
    onError: webappErrorNotification("Stop failed"),
  });
  const restart = useMutation({
    mutationFn: restartWebapp,
    onSuccess: invalidate,
    onError: webappErrorNotification("Restart failed"),
  });
  return {
    start,
    stop,
    restart,
    pending: start.isPending || stop.isPending || restart.isPending,
  };
}
