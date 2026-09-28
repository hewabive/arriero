import { queryOptions } from "@tanstack/react-query";

import { getWorkloadDataset, listWorkloadDatasets } from "../../api/client";

export const workloadDatasetsQuery = queryOptions({
  queryKey: ["workload-datasets"],
  queryFn: listWorkloadDatasets,
});

export function workloadDatasetQuery(datasetId: string) {
  return queryOptions({
    queryKey: ["workload-dataset", datasetId],
    queryFn: () => getWorkloadDataset(datasetId),
  });
}
