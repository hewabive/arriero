import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiProxySettings, updateApiProxySettings } from "../../api/client";

export function useApiProxySettings(onError: (error: unknown) => void) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["api-proxy-settings"],
    queryFn: getApiProxySettings,
  });
  const mutation = useMutation({
    mutationFn: updateApiProxySettings,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["api-proxy-settings"] }),
    onError,
  });
  return { query, mutation, settings: query.data?.data ?? null };
}
