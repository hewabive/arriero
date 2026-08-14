import type { ConfigStoreFileState } from "@arriero/core";

export type ConfigStoreRegistration = {
  id: string;
  files: () => string[];
  reset: () => void;
  status: () => ConfigStoreFileState[];
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

export function resetAllConfigStores(): void {
  for (const registration of registrations.values()) {
    registration.reset();
  }
}
