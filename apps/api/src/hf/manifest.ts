import { HfRepoIdSchema } from "@arriero/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { readValidatedJsonFile } from "../utils/json-file.js";

export const HF_MANIFEST_FILENAME = ".arriero-hf.json";

const HfManifestFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  oid: z.string().min(1),
  lfsOid: z.string().nullable(),
  lastCommitId: z.string().nullable(),
  lastCommitDate: z.string().nullable(),
});

const HfManifestSchema = z.object({
  version: z.literal(1),
  repoId: HfRepoIdSchema,
  revision: z.string().min(1),
  downloadedAt: z.string(),
  files: z.array(HfManifestFileSchema),
});

export type HfManifestFile = z.infer<typeof HfManifestFileSchema>;
export type HfManifest = z.infer<typeof HfManifestSchema>;

export function hfManifestPath(dir: string): string {
  return join(dir, HF_MANIFEST_FILENAME);
}

export function readHfManifest(dir: string): HfManifest | null {
  return readValidatedJsonFile(
    hfManifestPath(dir),
    HfManifestSchema,
    "hf download manifest",
  );
}

export function writeHfManifest(dir: string, manifest: HfManifest): void {
  atomicWriteFile(
    hfManifestPath(dir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export function ensureHfManifestHeader(
  dir: string,
  header: { repoId: string; revision: string },
): void {
  if (existsSync(hfManifestPath(dir))) {
    return;
  }
  writeHfManifest(dir, {
    version: 1,
    repoId: header.repoId,
    revision: header.revision,
    downloadedAt: new Date().toISOString(),
    files: [],
  });
}

export function upsertHfManifestFile(
  dir: string,
  header: { repoId: string; revision: string },
  file: HfManifestFile,
): HfManifest {
  const existing = readHfManifest(dir);
  const files = [
    ...(existing?.files.filter((entry) => entry.path !== file.path) ?? []),
    file,
  ].sort((a, b) => a.path.localeCompare(b.path));
  const manifest: HfManifest = {
    version: 1,
    repoId: header.repoId,
    revision: header.revision,
    downloadedAt: new Date().toISOString(),
    files,
  };
  writeHfManifest(dir, manifest);
  return manifest;
}
