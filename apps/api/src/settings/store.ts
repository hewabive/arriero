import { AppSettingsFileSchema, type AppSettingsFile } from "@arriero/core";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

import { config } from "../config.js";

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
  writeFileSync(filePath, `${JSON.stringify({}, null, 2)}\n`, "utf8");
}

export function readSettings(): AppSettingsFile {
  ensureFile();
  const raw = readFileSync(filePath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
  return AppSettingsFileSchema.parse(json);
}

export function writeSettings(next: AppSettingsFile): AppSettingsFile {
  const parsed = AppSettingsFileSchema.parse(next);
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
  return parsed;
}

export function initAppSettings() {
  ensureFile();
  readSettings();
}
