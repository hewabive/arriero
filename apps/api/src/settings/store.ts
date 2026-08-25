import { AppSettingsFileSchema, type AppSettingsFile } from "@arriero/core";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";

import { config } from "../config.js";
import {
  createJsonFileStore,
  serializeConfigJson,
} from "../config-store/file-store.js";

const filePath = config.settingsFile;
const seedPath = config.settingsSeedFile;

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

const store = createJsonFileStore<AppSettingsFile>({
  id: "settings",
  path: filePath,
  schema: AppSettingsFileSchema,
  missing: () => ({}),
  portablePaths: true,
  cache: "process",
  ensure: ensureFile,
});

export function readSettings(): AppSettingsFile {
  return store.read();
}

export function writeSettings(next: AppSettingsFile): AppSettingsFile {
  const parsed = AppSettingsFileSchema.parse(next);
  store.write(parsed);
  return parsed;
}

type MergeableSettingsSection =
  | "modelScan"
  | "environments"
  | "registries"
  | "downloads"
  | "logs";

export function updateSettingsSection<K extends MergeableSettingsSection>(
  key: K,
  value: NonNullable<AppSettingsFile[K]>,
): void {
  const settings = readSettings();
  writeSettings({ ...settings, [key]: { ...settings[key], ...value } });
}

export function resetSettingsCache() {
  store.reset();
}
