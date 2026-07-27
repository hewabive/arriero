import { PathCatalogEntrySchema } from "@arriero/core";
import { existsSync } from "node:fs";

import { sqlite } from "../db/index.js";
import { PATH_CATALOG_FILE, seedPathCatalog } from "./repository.js";

function tableExists(name: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}

export function migratePathCatalogToFile(): boolean {
  if (!tableExists("path_catalog")) {
    return false;
  }

  if (!existsSync(PATH_CATALOG_FILE)) {
    const rows = sqlite
      .prepare(
        "SELECT id, kind, name, path, created_at, updated_at FROM path_catalog",
      )
      .all() as Array<{
      id: string;
      kind: string;
      name: string;
      path: string;
      created_at: string;
      updated_at: string;
    }>;
    seedPathCatalog(
      rows.map((row) =>
        PathCatalogEntrySchema.parse({
          id: row.id,
          kind: row.kind,
          name: row.name,
          path: row.path,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      ),
    );
  }

  sqlite.exec("DROP TABLE IF EXISTS path_catalog");
  return true;
}
