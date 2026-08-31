import {
  HfDownloadSettingsSchema,
  type HfDownloadSettings,
} from "@arriero/core";

import { readSettings, writeSettings } from "./store.js";

const DEFAULT_HF_DOWNLOAD_SETTINGS = HfDownloadSettingsSchema.parse({});

export function getHfDownloadSettings(): HfDownloadSettings {
  return HfDownloadSettingsSchema.parse(
    readSettings().downloads ?? DEFAULT_HF_DOWNLOAD_SETTINGS,
  );
}

export function saveHfDownloadSettings(
  input: HfDownloadSettings,
): HfDownloadSettings {
  const parsed = HfDownloadSettingsSchema.parse(input);
  const settings = readSettings();
  const downloads = {
    ...(settings.downloads as Record<string, unknown> | undefined),
  };
  delete downloads.connections;
  delete downloads.chunkBytes;
  writeSettings({ ...settings, downloads: { ...downloads, ...parsed } });
  return parsed;
}
