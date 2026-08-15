import { resolve } from "node:path";
import { z } from "zod";

import {
  BenchmarkPromptSchema,
  type BenchmarkPrompt,
  type BenchmarkPromptUpdate,
} from "@arriero/core";

import { createJsonFileStore } from "../config-store/file-store.js";
import { config } from "../config.js";

const store = createJsonFileStore<BenchmarkPrompt[]>({
  id: "benchmark:prompts",
  path: resolve(config.configDir, "benchmark", "prompts.json"),
  schema: z.array(BenchmarkPromptSchema),
  missing: () => [],
  portablePaths: false,
  cache: "process",
});

export function listCustomBenchmarkPrompts(): BenchmarkPrompt[] {
  return store.read();
}

export function createCustomBenchmarkPrompt(
  prompt: BenchmarkPrompt,
): BenchmarkPrompt {
  store.write([...store.read(), prompt]);
  return prompt;
}

export function updateCustomBenchmarkPrompt(
  id: string,
  update: BenchmarkPromptUpdate,
): BenchmarkPrompt | null {
  const prompts = store.read();
  const index = prompts.findIndex((entry) => entry.id === id);
  const current = index >= 0 ? prompts[index] : undefined;
  if (!current) {
    return null;
  }
  const next = BenchmarkPromptSchema.parse({ ...current, ...update });
  store.write(prompts.map((entry) => (entry.id === id ? next : entry)));
  return next;
}

export function deleteCustomBenchmarkPrompt(id: string): boolean {
  const prompts = store.read();
  const next = prompts.filter((entry) => entry.id !== id);
  if (next.length === prompts.length) {
    return false;
  }
  store.write(next);
  return true;
}
