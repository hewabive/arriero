import type { ApiProxyTargetModelGroup } from "@arriero/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getApiProxyTargetModels } from "../../api/client";
import {
  useApiModelOptions,
  type ApiModelOptionsStatus,
} from "../hooks/use-api-model-options";
import type { ModelOption } from "./api-probe/types";

const groupOrder = [
  "Managed instances",
  "Remote instances",
  "External APIs",
  "arriero proxy",
] as const;

function endpointGroupLabel(group: ApiProxyTargetModelGroup): string {
  if (group.kind === "manager-proxy") return "arriero proxy";
  if (group.kind === "external-api") return "External APIs";
  if (group.remote) return "Remote instances";
  return "Managed instances";
}

function buildEndpointSelectData(groups: ApiProxyTargetModelGroup[]) {
  const byGroup = new Map<string, { value: string; label: string }[]>();
  for (const group of groups) {
    const label = endpointGroupLabel(group);
    const items = byGroup.get(label) ?? [];
    items.push({
      value: group.endpointId,
      label: group.online
        ? group.endpointName
        : `${group.endpointName} · offline`,
    });
    byGroup.set(label, items);
  }
  return groupOrder
    .filter((label) => byGroup.has(label))
    .map((label) => ({ group: label, items: byGroup.get(label) ?? [] }));
}

export function useEndpointModelCatalog(includeManagerProxy = false) {
  const query = useQuery({
    queryKey: ["api-proxy-target-models", includeManagerProxy],
    queryFn: () => getApiProxyTargetModels(includeManagerProxy),
  });
  const groups = useMemo(
    () => query.data?.data.groups ?? [],
    [query.data?.data.groups],
  );
  const endpointSelectData = useMemo(
    () => buildEndpointSelectData(groups),
    [groups],
  );
  return { groups, endpointSelectData };
}

export function useEndpointModelOptions(input: {
  endpointId: string | null;
  group: ApiProxyTargetModelGroup | undefined;
}): { modelOptions: ModelOption[]; status: ApiModelOptionsStatus } {
  const implied =
    input.group?.modelSource === "implied" ? input.group.impliedModel : null;
  const discovery = useApiModelOptions({
    profile: "openai",
    endpointId: implied ? null : input.endpointId,
    enabled: !implied && Boolean(input.endpointId),
    idleLabel: "Select an endpoint to list its models.",
  });
  return useMemo(() => {
    if (implied) {
      return {
        modelOptions: [{ value: implied, label: implied, status: null }],
        status: {
          state: "ok",
          label: "Model implied by the instance.",
        },
      };
    }
    return { modelOptions: discovery.modelOptions, status: discovery.status };
  }, [implied, discovery.modelOptions, discovery.status]);
}
