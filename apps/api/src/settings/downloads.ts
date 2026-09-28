import {
  HfDownloadSettingsSchema,
  HfDownloadSettingsUpdateSchema,
  type HfDownloadSettings,
  type HfDownloadSettingsUpdate,
} from "@arriero/core";

import { readSettings, updateSettingsSection } from "./store.js";

const DEFAULT_HF_DOWNLOAD_SETTINGS = HfDownloadSettingsSchema.parse({});

export function getHfDownloadSettings(): HfDownloadSettings {
  return readSettings().downloads ?? DEFAULT_HF_DOWNLOAD_SETTINGS;
}

export function saveHfDownloadSettings(
  input: HfDownloadSettingsUpdate,
): HfDownloadSettings {
  const update = HfDownloadSettingsUpdateSchema.parse(input);
  const current = getHfDownloadSettings();
  const next: HfDownloadSettings = {
    modelDirectoryId:
      update.modelDirectoryId === undefined
        ? current.modelDirectoryId
        : update.modelDirectoryId,
    maxEtaHours:
      update.maxEtaHours === undefined
        ? current.maxEtaHours
        : update.maxEtaHours,
  };
  updateSettingsSection("downloads", next);
  return next;
}
