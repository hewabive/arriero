import { Group, Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { getApiProxyTraceFacets } from "../../api/client";
import {
  WORKLOAD_PERIOD_OPTIONS,
  facetSelectData,
  isWorkloadPeriod,
  type WorkloadScopeState,
} from "./workload-scope";

export function WorkloadScopeFilters(props: {
  scope: WorkloadScopeState;
  onScopeChange: (scope: WorkloadScopeState) => void;
  periodOverride?: ReactNode;
  afterPeriod?: ReactNode;
  children?: ReactNode;
}) {
  const facetsQuery = useQuery({
    queryKey: ["api-proxy-trace-facets"],
    queryFn: getApiProxyTraceFacets,
  });
  const facets = facetsQuery.data?.data;
  return (
    <Group gap="xs" align="flex-end" wrap="wrap">
      {props.periodOverride ?? (
        <Select
          size="xs"
          w={160}
          label="Period"
          value={props.scope.period}
          data={WORKLOAD_PERIOD_OPTIONS}
          allowDeselect={false}
          onChange={(value) => {
            if (value && isWorkloadPeriod(value)) {
              props.onScopeChange({ ...props.scope, period: value });
            }
          }}
        />
      )}
      {props.afterPeriod}
      <Select
        size="xs"
        w={180}
        label="Source"
        placeholder="All"
        clearable
        value={props.scope.sourceId}
        data={facetSelectData(facets?.sources)}
        onChange={(value) =>
          props.onScopeChange({ ...props.scope, sourceId: value })
        }
      />
      <Select
        size="xs"
        w={200}
        label="Model"
        placeholder="All"
        clearable
        searchable
        value={props.scope.modelId}
        data={facetSelectData(facets?.models)}
        onChange={(value) =>
          props.onScopeChange({ ...props.scope, modelId: value })
        }
      />
      {props.children}
    </Group>
  );
}
