import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { getModelScanSettings } from "../models/cache-repository.js";
import {
  createPathCatalogEntry,
  seedPathCatalog,
  updatePathCatalogEntry,
} from "../path-catalog/repository.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import { defaultHfDestDir } from "./paths.js";

beforeEach(() => {
  seedPathCatalog([]);
  saveHfDownloadSettings({
    modelDirectoryId: null,
    connections: 6,
    chunkBytes: 32 * 1024 * 1024,
    maxEtaHours: 24,
  });
});

test("defaultHfDestDir uses the selected model directory", () => {
  const entry = createPathCatalogEntry({
    kind: "models-dir",
    name: "Fast storage",
    path: "/mnt/models-a",
  });
  saveHfDownloadSettings({
    modelDirectoryId: entry.id,
    connections: 6,
    chunkBytes: 32 * 1024 * 1024,
    maxEtaHours: 24,
  });

  assert.equal(
    defaultHfDestDir("owner/repo"),
    join("/mnt/models-a", "owner", "repo"),
  );

  updatePathCatalogEntry(entry.id, { path: "/mnt/models-b" });
  assert.equal(
    defaultHfDestDir("owner/repo"),
    join("/mnt/models-b", "owner", "repo"),
  );
});

test("defaultHfDestDir falls back when the saved directory is unavailable", () => {
  saveHfDownloadSettings({
    modelDirectoryId: "missing-model-directory",
    connections: 6,
    chunkBytes: 32 * 1024 * 1024,
    maxEtaHours: 24,
  });

  assert.equal(
    defaultHfDestDir("owner/repo"),
    join(getModelScanSettings().directory, "owner", "repo"),
  );
});
