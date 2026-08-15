import type {
  GgufModel,
  ModelScanRequest,
  ModelScanResult,
  ModelScanRoot,
  ModelScanState,
} from "@arriero/core";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { scanModels, startModelScan } from "../../api/client";

const SCAN_POLL_MS = 1000;
const ERROR_POLL_MS = 5000;

export type ScannedModels = {
  models: GgufModel[];
  roots: ModelScanRoot[];
  scan: ModelScanState;
  reconciling: boolean;
  coldLoading: boolean;
  fetched: boolean;
  cache: ModelScanResult["cache"] | undefined;
  isError: boolean;
  error: Error | null;
  rescan: () => void;
  refreshMetadata: () => void;
};

const idleScan: ModelScanState = {
  status: "idle",
  done: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

export function useScannedModels(options?: {
  enabled?: boolean;
}): ScannedModels {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const requestedRef = useRef(false);

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: scanModels,
    enabled,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.status === "error") {
        return ERROR_POLL_MS;
      }
      return query.state.data?.data.scan.status === "scanning"
        ? SCAN_POLL_MS
        : false;
    },
  });

  const startScan = useCallback(
    (input?: ModelScanRequest) => {
      void startModelScan(input)
        .then((response) => {
          queryClient.setQueryData<{ data: ModelScanResult }>(
            ["models"],
            (current) =>
              current
                ? { data: { ...current.data, scan: response.data } }
                : current,
          );
          void queryClient.invalidateQueries({ queryKey: ["models"] });
        })
        .catch((error: unknown) => {
          notifications.show({
            color: "red",
            title: "Model scan failed",
            message: (error as Error).message,
          });
        });
    },
    [queryClient],
  );

  useEffect(() => {
    if (!enabled || requestedRef.current) {
      return;
    }
    requestedRef.current = true;
    startScan();
  }, [enabled, startScan]);

  const result = modelsQuery.data?.data;
  const scan = result?.scan ?? idleScan;

  return {
    models: result?.models ?? [],
    roots: result?.roots ?? [],
    scan,
    reconciling: scan.status === "scanning" || modelsQuery.isFetching,
    coldLoading: modelsQuery.isLoading,
    fetched: modelsQuery.isFetched,
    cache: result?.cache,
    isError: modelsQuery.isError,
    error: (modelsQuery.error as Error | null) ?? null,
    rescan: () => startScan(),
    refreshMetadata: () => startScan({ refresh: true }),
  };
}
