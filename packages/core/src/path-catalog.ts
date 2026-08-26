import { z } from "zod";

import { type InstanceKind } from "./engine-descriptor.js";
import { InstanceKindSchema } from "./instance.js";
import { updateSchemaFrom } from "./schema-update.js";

export const PathCatalogKindSchema = z.enum(["binary", "models-dir"]);

export const PathCatalogEntrySchema = z.object({
  id: z.string(),
  kind: PathCatalogKindSchema,
  name: z.string().min(1).max(80),
  path: z.string().min(1),
  engineKind: InstanceKindSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PathCatalogCreateSchema = z.object({
  kind: PathCatalogKindSchema,
  name: z.string().min(1).max(80),
  path: z.string().min(1),
  engineKind: InstanceKindSchema.optional(),
});

export const PathCatalogUpdateSchema = updateSchemaFrom(
  PathCatalogCreateSchema.omit({ kind: true }),
).extend({
  engineKind: InstanceKindSchema.nullable().optional(),
});

const RPC_SERVER_BINARY_BASENAME = "ggml-rpc-server";

export function pathCatalogBinaryEngineKind(entry: {
  path: string;
  engineKind?: InstanceKind | undefined;
}): InstanceKind {
  if (entry.engineKind) {
    return entry.engineKind;
  }
  const basename = entry.path.split("/").pop() ?? entry.path;
  return basename === RPC_SERVER_BINARY_BASENAME
    ? "rpc-worker"
    : "llama-server";
}

export type PathCatalogKind = z.infer<typeof PathCatalogKindSchema>;
export type PathCatalogEntry = z.infer<typeof PathCatalogEntrySchema>;
export type PathCatalogCreate = z.infer<typeof PathCatalogCreateSchema>;
export type PathCatalogUpdate = z.infer<typeof PathCatalogUpdateSchema>;
