export type ConfigStoreRegistration = {
  id: string;
  files: () => string[];
  reset: () => void;
};

const registrations = new Map<string, ConfigStoreRegistration>();

export function registerConfigStore(
  registration: ConfigStoreRegistration,
): void {
  registrations.set(registration.id, registration);
}

export function resetAllConfigStores(): void {
  for (const registration of registrations.values()) {
    registration.reset();
  }
}
