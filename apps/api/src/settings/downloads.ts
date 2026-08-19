import {
  HfDownloadSettingsSchema,
  type HfDownloadSettings,
} from "@arriero/core";

import { readSettings, writeSettings } from "./store.js";

const DEFAULT_HF_DOWNLOAD_SETTINGS = HfDownloadSettingsSchema.parse({});

export function getHfDownloadSettings(): HfDownloadSettings {
  return readSettings().downloads ?? DEFAULT_HF_DOWNLOAD_SETTINGS;
}

export function saveHfDownloadSettings(
  input: HfDownloadSettings,
): HfDownloadSettings {
  const parsed = HfDownloadSettingsSchema.parse(input);
  writeSettings({
    ...readSettings(),
    downloads: parsed,
  });
  return parsed;
}
