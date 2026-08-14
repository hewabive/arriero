import { AppSettingsFileSchema, type AppSettingsFile } from "@arriero/core";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";

import { config } from "../config.js";
import {
  createJsonFileStore,
  serializeConfigJson,
} from "../config-store/file-store.js";

const filePath = config.settingsFile;
const seedPath = config.settingsSeedFile;

const store = createJsonFileStore<AppSettingsFile>({
  id: "settings",
  path: filePath,
  schema: AppSettingsFileSchema,
  missing: () => ({}),
  portablePaths: true,
  cache: "process",
});

function ensureFile() {
  if (existsSync(filePath)) {
    return;
  }
  if (existsSync(seedPath)) {
    copyFileSync(seedPath, filePath);
    return;
  }
  writeFileSync(filePath, serializeConfigJson({}), "utf8");
}

export function readSettings(): AppSettingsFile {
  ensureFile();
  return store.read();
}

export function writeSettings(next: AppSettingsFile): AppSettingsFile {
  const parsed = AppSettingsFileSchema.parse(next);
  store.write(parsed);
  return parsed;
}

export function initAppSettings() {
  ensureFile();
  readSettings();
}

export function resetSettingsCache() {
  store.reset();
}
