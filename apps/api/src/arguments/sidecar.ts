import { ArgumentOptionSchema } from "@arriero/core";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { type binaryStat } from "./binary-discovery.js";
import { fillMissingDefaultValues } from "./help-parser.js";
import { type CachedArgumentCatalog } from "./repository.js";

const SIDECAR_VERSION = 2;
const LEGACY_SIDECAR_PARSER = "llama-help";

const SidecarSchema = z.object({
  version: z.literal(SIDECAR_VERSION),
  binarySize: z.number(),
  binaryMtimeMs: z.string(),
  binaryModifiedAt: z.string(),
  helpHash: z.string(),
  generatedAt: z.string(),
  parser: z.string(),
  options: ArgumentOptionSchema.array(),
});

const LegacySidecarSchema = z.object({
  version: z.literal(1),
  binarySize: z.number(),
  binaryMtimeMs: z.string(),
  binaryModifiedAt: z.string(),
  helpHash: z.string(),
  generatedAt: z.string(),
  options: ArgumentOptionSchema.array(),
});

function parseSidecarPayload(raw: unknown) {
  const current = SidecarSchema.safeParse(raw);
  if (current.success) {
    return current.data;
  }
  const legacy = LegacySidecarSchema.safeParse(raw);
  if (legacy.success) {
    return { ...legacy.data, parser: LEGACY_SIDECAR_PARSER };
  }
  return null;
}

export function argumentCatalogSidecarPath(binaryPath: string) {
  return join(dirname(binaryPath), `.${basename(binaryPath)}.llama-args.json`);
}

export function readArgumentCatalogSidecar(
  binaryPath: string,
  stat: ReturnType<typeof binaryStat>,
): CachedArgumentCatalog | null {
  try {
    const data = parseSidecarPayload(
      JSON.parse(readFileSync(argumentCatalogSidecarPath(binaryPath), "utf8")),
    );
    if (!data) {
      return null;
    }
    if (
      data.binarySize !== stat.binarySize ||
      data.binaryMtimeMs !== stat.binaryMtimeMs
    ) {
      return null;
    }
    return {
      binaryPath,
      binarySize: data.binarySize,
      binaryMtimeMs: data.binaryMtimeMs,
      binaryModifiedAt: data.binaryModifiedAt,
      helpHash: data.helpHash,
      options: fillMissingDefaultValues(data.options),
      generatedAt: data.generatedAt,
      parserId: data.parser,
    };
  } catch {
    return null;
  }
}

export function writeArgumentCatalogSidecar(catalog: CachedArgumentCatalog) {
  const path = argumentCatalogSidecarPath(catalog.binaryPath);
  const payload = {
    version: SIDECAR_VERSION,
    binarySize: catalog.binarySize,
    binaryMtimeMs: catalog.binaryMtimeMs,
    binaryModifiedAt: catalog.binaryModifiedAt,
    helpHash: catalog.helpHash,
    generatedAt: catalog.generatedAt,
    parser: catalog.parserId,
    options: catalog.options,
  };
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, path);
  } catch {
    return;
  }
}
