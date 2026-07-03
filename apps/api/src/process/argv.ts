import type { EngineArgvBuilderId, InstanceArgs } from "@llama-manager/core";

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

export const ENGINE_ARGV_BUILDERS: Record<
  EngineArgvBuilderId,
  EngineArgvBuilder
> = {
  "flag-map": flagMapArgv,
};

export function engineArgvBuilder(id: EngineArgvBuilderId): EngineArgvBuilder {
  return ENGINE_ARGV_BUILDERS[id];
}
