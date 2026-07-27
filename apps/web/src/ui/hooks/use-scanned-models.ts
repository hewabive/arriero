import type { GgufModel, ModelScanResult, ModelScanRoot } from "@arriero/core";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { scanModels } from "../../api/client";

export type ScannedModels = {
  models: GgufModel[];
  roots: ModelScanRoot[];
  scannedAt: string;
  ready: boolean;
  reconciling: boolean;
  coldLoading: boolean;
  fetched: boolean;
  cache: ModelScanResult["cache"] | undefined;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
};

export function useScannedModels(options?: {
  enabled?: boolean;
}): ScannedModels {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;

  const cachedQuery = useQuery({
    queryKey: ["models", "cache"],
    queryFn: () => scanModels({ cached: true }),
    enabled,
    retry: false,
    staleTime: Infinity,
  });

  const liveQuery = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const result = await scanModels();
      queryClient.setQueryData(["models", "cache"], result);
      return result;
    },
    enabled,
    retry: false,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const live: ModelScanResult | undefined = liveQuery.data?.data;
  const cached: ModelScanResult | undefined = cachedQuery.data?.data;
  const effective = live ?? cached;

  return {
    models: effective?.models ?? [],
    roots: effective?.roots ?? [],
    scannedAt: effective?.scannedAt ?? "",
    ready: Boolean(effective),
    reconciling: liveQuery.isFetching,
    coldLoading: !cached && liveQuery.isLoading,
    fetched: liveQuery.isFetched,
    cache: live?.cache,
    isError: liveQuery.isError,
    error: (liveQuery.error as Error | null) ?? null,
    refetch: () => {
      void liveQuery.refetch();
    },
  };
}
