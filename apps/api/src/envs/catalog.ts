import type { EnvironmentSpec } from "@llama-manager/core";

import {
  createPathCatalogEntry,
  getPathCatalogEntry,
  listPathCatalogEntries,
  updatePathCatalogEntry,
} from "../path-catalog/repository.js";
import { environmentEntrypoint } from "./paths.js";
import { updateEnvironmentSpec } from "./repository.js";

export function reconcileEnvironmentCatalog(spec: EnvironmentSpec) {
  const path = environmentEntrypoint(spec);
  const desiredName = `vllm ${spec.version} [${spec.id.slice(0, 8)}]`.slice(0, 80);
  const stored = spec.pathCatalogEntryId
    ? getPathCatalogEntry(spec.pathCatalogEntryId)
    : null;
  let entry =
    stored?.kind === "binary"
      ? updatePathCatalogEntry(stored.id, {
          name: desiredName,
          path,
          engineKind: "vllm",
        })
      : null;
  if (!entry) {
    const byPath = listPathCatalogEntries("binary").find(
      (candidate) => candidate.path === path,
    );
    entry = byPath
      ? updatePathCatalogEntry(byPath.id, {
          name: desiredName,
          engineKind: "vllm",
        })
      : createPathCatalogEntry({
          kind: "binary",
          name: desiredName,
          path,
          engineKind: "vllm",
        });
  }
  if (!entry) {
    throw new Error("failed to reconcile environment path-catalog entry");
  }
  if (entry && entry.id !== spec.pathCatalogEntryId) {
    updateEnvironmentSpec(spec.id, { pathCatalogEntryId: entry.id });
  }
  return entry;
}
