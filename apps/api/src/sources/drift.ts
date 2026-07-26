import type { SourceSyncReport } from "@llama-manager/core";

import { getLlamaSourceSyncReport } from "../llama/source-sync.js";
import { getSourceRepositoryDefinition } from "./registry.js";

const driftAdapters = new Map<string, () => SourceSyncReport>([
  ["llama-cpp", getLlamaSourceSyncReport],
]);

export function getSourceRepositoryDriftReport(
  sourceId: string,
): SourceSyncReport {
  const definition = getSourceRepositoryDefinition(sourceId);
  if (!definition.driftSupported) {
    throw new Error(`source repository ${sourceId} has no drift adapter`);
  }
  const adapter = driftAdapters.get(definition.adapter);
  if (!adapter) {
    throw new Error(
      `drift adapter ${definition.adapter} is unavailable for source repository ${sourceId}`,
    );
  }
  const report = adapter();
  if (report.sourceId !== sourceId) {
    throw new Error(
      `drift adapter ${definition.adapter} returned source ${report.sourceId}, expected ${sourceId}`,
    );
  }
  return report;
}
