import {
  EnvironmentRepositorySettingsSchema,
  type EnvironmentRepositorySettings,
} from "@arriero/core";

import { readSettings, writeSettings } from "../settings/store.js";

export function getEnvironmentRepositorySettings(): EnvironmentRepositorySettings {
  return EnvironmentRepositorySettingsSchema.parse(
    readSettings().environments ?? {},
  );
}

export function saveEnvironmentRepositorySettings(
  input: EnvironmentRepositorySettings,
): EnvironmentRepositorySettings {
  const parsed = EnvironmentRepositorySettingsSchema.parse(input);
  writeSettings({
    ...readSettings(),
    environments: parsed,
  });
  return parsed;
}
