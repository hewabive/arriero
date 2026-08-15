const currentPrefix = "ARRIERO_";
const legacyPrefix = "LLAMA_MANAGER_";

const warnedLegacyNames = new Set<string>();

export function managerEnv(suffix: string): string | undefined {
  const current = process.env[`${currentPrefix}${suffix}`];
  if (current !== undefined) {
    return current;
  }
  const legacyName = `${legacyPrefix}${suffix}`;
  const legacy = process.env[legacyName];
  if (legacy !== undefined && !warnedLegacyNames.has(legacyName)) {
    warnedLegacyNames.add(legacyName);
    process.emitWarning(
      `${legacyName} is deprecated; rename it to ${currentPrefix}${suffix}`,
      "DeprecationWarning",
    );
  }
  return legacy;
}

export function managerEnvNonEmpty(suffix: string): string | undefined {
  const value = managerEnv(suffix);
  return value === "" ? undefined : value;
}
