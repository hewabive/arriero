import {
  PackageRegistriesSettingsSchema,
  type PackageRegistriesSettings,
} from "@arriero/core";

import { readSettings, updateSettingsSection } from "./store.js";

const DEFAULT_REGISTRIES_SETTINGS = PackageRegistriesSettingsSchema.parse({});

export function getPackageRegistriesSettings(): PackageRegistriesSettings {
  return readSettings().registries ?? DEFAULT_REGISTRIES_SETTINGS;
}

export function savePackageRegistriesSettings(
  input: PackageRegistriesSettings,
): PackageRegistriesSettings {
  const parsed = PackageRegistriesSettingsSchema.parse(input);
  updateSettingsSection("registries", parsed);
  return parsed;
}
