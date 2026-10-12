import { engineDescriptor } from "./engine-descriptor.js";
import type { Instance } from "./instance.js";

function positiveIntegerArg(
  args: Instance["args"],
  keys: readonly string[],
): number | undefined {
  const raw = keys.map((key) => args[key]).find((value) => value !== undefined);
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const CONCURRENCY_LIMIT_KEYS = {
  "llama-parallel": [["--parallel", "-np"]],
  "vllm-sequences": [["--max-num-seqs"], ["--max-num-active-seqs"]],
  "sglang-max-running-requests": [["--max-running-requests"]],
  none: [],
} as const;

export function parseInstanceConcurrencyLimit(
  instance: Pick<Instance, "kind" | "args">,
): number | undefined {
  const limits = CONCURRENCY_LIMIT_KEYS[
    engineDescriptor(instance.kind).concurrency
  ]
    .map((keys) => positiveIntegerArg(instance.args, keys))
    .filter((limit) => limit !== undefined);
  return limits.length > 0 ? Math.min(...limits) : undefined;
}
