import { ArgumentOptionSchema, type ArgumentOption } from "@llama-manager/core";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";

import { db } from "../db/index.js";
import { llamaArgumentCatalogs } from "../db/schema.js";

type CatalogRow = typeof llamaArgumentCatalogs.$inferSelect;

export type CachedArgumentCatalog = {
  binaryPath: string;
  binarySize: number;
  binaryMtimeMs: string;
  binaryModifiedAt: string;
  helpHash: string;
  options: ArgumentOption[];
  generatedAt: string;
  parserId: string;
};

function toCatalog(row: CatalogRow): CachedArgumentCatalog {
  return {
    binaryPath: row.binaryPath,
    binarySize: Number(row.binarySize),
    binaryMtimeMs: row.binaryMtimeMs,
    binaryModifiedAt: row.binaryModifiedAt,
    helpHash: row.helpHash,
    options: ArgumentOptionSchema.array().parse(
      JSON.parse(row.optionsJson) as unknown,
    ),
    generatedAt: row.generatedAt,
    parserId: row.parserId,
  };
}

export function getCachedArgumentCatalog(
  binaryPath: string,
): CachedArgumentCatalog | null {
  const row = db
    .select()
    .from(llamaArgumentCatalogs)
    .where(eq(llamaArgumentCatalogs.binaryPath, binaryPath))
    .get();
  return row ? toCatalog(row) : null;
}

export function saveArgumentCatalog(
  input: CachedArgumentCatalog,
): CachedArgumentCatalog {
  const current = getCachedArgumentCatalog(input.binaryPath);
  const values = {
    binarySize: String(input.binarySize),
    binaryMtimeMs: input.binaryMtimeMs,
    binaryModifiedAt: input.binaryModifiedAt,
    helpHash: input.helpHash,
    optionsJson: JSON.stringify(input.options),
    generatedAt: input.generatedAt,
    parserId: input.parserId,
  };

  if (current) {
    db.update(llamaArgumentCatalogs)
      .set(values)
      .where(eq(llamaArgumentCatalogs.binaryPath, input.binaryPath))
      .run();
  } else {
    db.insert(llamaArgumentCatalogs)
      .values({ binaryPath: input.binaryPath, ...values })
      .run();
  }

  const saved = getCachedArgumentCatalog(input.binaryPath);
  if (!saved) {
    throw new Error("failed to save argument catalog");
  }
  return saved;
}

export function pruneMissingArgumentCatalogs(): number {
  const rows = db.select().from(llamaArgumentCatalogs).all();
  let deleted = 0;

  for (const row of rows) {
    if (existsSync(row.binaryPath)) {
      continue;
    }

    const result = db
      .delete(llamaArgumentCatalogs)
      .where(eq(llamaArgumentCatalogs.binaryPath, row.binaryPath))
      .run();
    deleted += result.changes;
  }

  return deleted;
}
