import {
  EnvironmentRepositorySettingsSchema,
  type EnvironmentRepositorySettings,
} from "@arriero/core";

import { readSettings, updateSettingsSection } from "../settings/store.js";

const DEFAULT_REPOSITORY_SETTINGS = EnvironmentRepositorySettingsSchema.parse(
  {},
);

export function getEnvironmentRepositorySettings(): EnvironmentRepositorySettings {
  return readSettings().environments ?? DEFAULT_REPOSITORY_SETTINGS;
}

export function saveEnvironmentRepositorySettings(
  input: EnvironmentRepositorySettings,
): EnvironmentRepositorySettings {
  const parsed = EnvironmentRepositorySettingsSchema.parse(input);
  updateSettingsSection("environments", parsed);
  return parsed;
}
