import type { ApiLabProbeProfile } from "@arriero/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getApiLabModels } from "../../api/client";
import { modelOptionsFromProbe } from "../components/api-probe/utils";

export type ApiModelOptionsStatus = {
  state: "idle" | "loading" | "ok" | "error";
  label: string;
};

export function useApiModelOptions(input: {
  profile?: ApiLabProbeProfile | undefined;
  baseUrl?: string | undefined;
  endpointId?: string | null;
  enabled?: boolean;
  idleLabel?: string | undefined;
}) {
  const profile = input.profile ?? "openai";
  const baseUrl = input.baseUrl?.trim() ?? "";
  const endpointId = input.endpointId ?? null;
  const canQuery = Boolean((input.enabled ?? true) && (baseUrl || endpointId));
  const query = useQuery({
    queryKey: ["api-lab-models", profile, baseUrl, endpointId],
    queryFn: () => getApiLabModels(profile, baseUrl, endpointId),
    enabled: canQuery,
    staleTime: 15_000,
  });
  const modelOptions = useMemo(
    () => modelOptionsFromProbe(query.data?.data),
    [query.data?.data],
  );
  const status = useMemo<ApiModelOptionsStatus>(() => {
    if (!canQuery) {
      return {
        state: "idle",
        label: input.idleLabel ?? "Model list was not checked.",
      };
    }
    if (query.isFetching) {
      return { state: "loading", label: "Checking /models..." };
    }
    if (query.error) {
      return {
        state: "error",
        label: `Model list request failed: ${(query.error as Error).message}`,
      };
    }
    const probe = query.data?.data;
    if (probe && !probe.ok) {
      return {
        state: "error",
        label: `Model list request failed: ${probe.error ?? `HTTP ${probe.status ?? "no response"}`}`,
      };
    }
    if (probe?.ok) {
      return {
        state: "ok",
        label: `${modelOptions.length} model${modelOptions.length === 1 ? "" : "s"} available from /models.`,
      };
    }
    return {
      state: "idle",
      label: input.idleLabel ?? "Model list was not checked.",
    };
  }, [
    canQuery,
    input.idleLabel,
    modelOptions.length,
    query.data?.data,
    query.error,
    query.isFetching,
  ]);

  return {
    modelOptions,
    status,
  };
}
