import type { PublicProxyModel, PublicStatus } from "@arriero/core";

import { config } from "./config.js";
import { apiProxyInflight } from "./proxy/inflight.js";
import { deriveApiProxyModelStatus } from "./proxy/model-status.js";
import {
  listApiProxyModels,
  listApiProxyPipelines,
} from "./proxy/repository.js";
import { getCachedApiProxyRuntimeSnapshot } from "./proxy/runtime-snapshot.js";

async function getPublicModels(): Promise<PublicStatus["models"]> {
  const { snapshot } = await getCachedApiProxyRuntimeSnapshot();
  const pipelinesById = new Map(
    listApiProxyPipelines().map((pipeline) => [pipeline.id, pipeline]),
  );
  const inflightByModel = apiProxyInflight.snapshotByModel();
  const modelItems: PublicProxyModel[] = listApiProxyModels()
    .filter((model) => model.visible)
    .map((model) => ({
      modelId: model.modelId,
      status: deriveApiProxyModelStatus({
        model,
        snapshot,
        pipelinesById,
        inflight: inflightByModel.get(model.modelId) ?? [],
      }),
    }));

  return {
    total: modelItems.length,
    loaded: modelItems.filter((item) => item.status.value === "loaded").length,
    activeRequests: modelItems.reduce(
      (sum, item) => sum + item.status.activeRequests,
      0,
    ),
    queuedRequests: modelItems.reduce(
      (sum, item) => sum + item.status.queuedRequests,
      0,
    ),
    items: modelItems,
  };
}

export async function getPublicStatus(): Promise<PublicStatus> {
  return {
    service: {
      ok: true,
      authRequired: Boolean(config.auth.password || config.auth.passwordHash),
      checkedAt: new Date().toISOString(),
    },
    models: await getPublicModels(),
  };
}
