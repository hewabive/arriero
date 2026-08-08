import type { EngineArgvBuilderId, InstanceArgs } from "@arriero/core";

export type EngineArgvBuilder = (
  args: InstanceArgs,
  positional: readonly string[],
) => string[];

function flagMapArgv(
  args: InstanceArgs,
  positional: readonly string[],
): string[] {
  const result: string[] = [...positional];

  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    if (value === false || value === null || value === undefined) {
      continue;
    }
    if (value === true) {
      result.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => item.trim())
        .filter(Boolean)
        .join(",");
      if (joined) {
        result.push(key, joined);
      }
      continue;
    }
    result.push(key, String(value));
  }

  return result;
}

function argparseFlagsArgv(
  args: InstanceArgs,
  positional: readonly string[],
): string[] {
  const result: string[] = [...positional];

  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    if (value === false || value === null || value === undefined) {
      continue;
    }
    if (value === true) {
      result.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => item.trim()).filter(Boolean);
      if (items.length > 0) {
        result.push(key, ...items);
      }
      continue;
    }
    result.push(key, String(value));
  }

  return result;
}

const ENGINE_ARGV_BUILDERS: Record<EngineArgvBuilderId, EngineArgvBuilder> = {
  "flag-map": flagMapArgv,
  "argparse-flags": argparseFlagsArgv,
};

export function engineArgvBuilder(id: EngineArgvBuilderId): EngineArgvBuilder {
  return ENGINE_ARGV_BUILDERS[id];
}
