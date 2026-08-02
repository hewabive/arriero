import {
  ApiProxyModelRecordSchema,
  apiEndpointModelFilterAdmits,
  type ApiEndpointRecord,
  type ApiProxyModelRecord,
} from "@arriero/core";

import {
  getCachedEndpointModelIds,
  getEndpointModelIds,
} from "./endpoint-models.js";
import { listPassthroughEndpoints } from "./endpoints.js";
import { listApiProxyModels } from "./repository.js";

function passthroughModelRecord(input: {
  endpoint: ApiEndpointRecord;
  modelId: string;
  visible: boolean;
}): ApiProxyModelRecord {
  return ApiProxyModelRecordSchema.parse({
    id: `passthrough:${input.endpoint.id}:${input.modelId}`,
    modelId: input.modelId,
    visible: input.visible,
    enabled: true,
    ownedBy: input.endpoint.name,
    targetId: null,
    routeTo: {
      type: "endpoint",
      endpointId: input.endpoint.id,
      upstreamModel: input.modelId,
    },
    description: null,
  });
}

export function resolvePassthroughModel(
  modelId: string,
): ApiProxyModelRecord | null {
  const admits = listPassthroughEndpoints().filter((endpoint) =>
    apiEndpointModelFilterAdmits(endpoint.modelFilter, modelId),
  );
  if (admits.length === 0) {
    return null;
  }

  const owner =
    admits.find((endpoint) =>
      Boolean(getCachedEndpointModelIds(endpoint.id)?.includes(modelId)),
    ) ?? admits[0];
  if (!owner) {
    return null;
  }

  return passthroughModelRecord({
    endpoint: owner,
    modelId,
    visible: false,
  });
}

export async function listPublicProxyModels(): Promise<ApiProxyModelRecord[]> {
  const explicit = listApiProxyModels();
  const endpoints = listPassthroughEndpoints();
  if (endpoints.length === 0) {
    return explicit;
  }

  const seen = new Set(explicit.map((model) => model.modelId));
  const lists = await Promise.all(
    endpoints.map((endpoint) => getEndpointModelIds(endpoint)),
  );

  const passthrough: ApiProxyModelRecord[] = [];
  endpoints.forEach((endpoint, index) => {
    for (const upstreamId of lists[index] ?? []) {
      if (seen.has(upstreamId)) {
        continue;
      }
      if (!apiEndpointModelFilterAdmits(endpoint.modelFilter, upstreamId)) {
        continue;
      }
      seen.add(upstreamId);
      passthrough.push(
        passthroughModelRecord({
          endpoint,
          modelId: upstreamId,
          visible: true,
        }),
      );
    }
  });

  return [...explicit, ...passthrough];
}
