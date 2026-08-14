import type { ConfigStoreFileState } from "@arriero/core";

import { ConfigFileError } from "./errors.js";

export type ConfigStoreRegistration = {
  id: string;
  files: () => string[];
  init: () => void;
  reset: () => void;
  status: () => ConfigStoreFileState[];
};

export type ConfigStoreInitFailure = {
  storeId: string;
  path: string;
  message: string;
};

const registrations = new Map<string, ConfigStoreRegistration>();

export function registerConfigStore(
  registration: ConfigStoreRegistration,
): void {
  registrations.set(registration.id, registration);
}

export function listConfigStoreStates(): ConfigStoreFileState[] {
  return [...registrations.values()]
    .flatMap((registration) => registration.status())
    .sort(
      (left, right) =>
        left.storeId.localeCompare(right.storeId) ||
        left.path.localeCompare(right.path),
    );
}

export function initConfigStores(): ConfigStoreInitFailure[] {
  const failures: ConfigStoreInitFailure[] = [];
  for (const registration of registrations.values()) {
    try {
      registration.init();
    } catch (error) {
      if (error instanceof ConfigFileError) {
        failures.push({
          storeId: registration.id,
          path: error.path,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
  }
  return failures;
}

export function resetAllConfigStores(): void {
  for (const registration of registrations.values()) {
    registration.reset();
  }
}
