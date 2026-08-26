import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  BenchmarkPromptSchema,
  type BenchmarkPrompt,
  type BenchmarkPromptCreate,
  type BenchmarkPromptMeta,
  type BenchmarkPromptUpdate,
  type BenchmarkPromptWithSource,
} from "@arriero/core";

import { config } from "../config.js";
import { newId } from "../utils/id.js";
import { readValidatedJsonFile } from "../utils/json-file.js";
import { BenchmarkConflictError } from "./errors.js";
import {
  createCustomBenchmarkPrompt,
  deleteCustomBenchmarkPrompt,
  listCustomBenchmarkPrompts,
  updateCustomBenchmarkPrompt,
} from "./custom-prompts.js";

const benchmarkPromptsDirectory = resolve(
  config.rootDir,
  "content",
  "benchmark-prompts",
);

const BUILTIN_CACHE_TTL_MS = 5_000;

let builtinCache: { prompts: BenchmarkPrompt[]; expiresAt: number } | null =
  null;

function readBuiltinPrompts(): BenchmarkPrompt[] {
  if (!existsSync(benchmarkPromptsDirectory)) {
    return [];
  }
  const prompts: BenchmarkPrompt[] = [];
  for (const topicEntry of readdirSync(benchmarkPromptsDirectory, {
    withFileTypes: true,
  })) {
    if (!topicEntry.isDirectory()) continue;
    const topicDir = resolve(benchmarkPromptsDirectory, topicEntry.name);
    for (const fileEntry of readdirSync(topicDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
      const prompt = readValidatedJsonFile(
        resolve(topicDir, fileEntry.name),
        BenchmarkPromptSchema,
        "builtin benchmark prompt",
      );
      if (prompt) {
        prompts.push(prompt);
      }
    }
  }
  return prompts.sort((a, b) => a.id.localeCompare(b.id));
}

export function listBuiltinBenchmarkPrompts(): BenchmarkPrompt[] {
  const now = Date.now();
  if (builtinCache && builtinCache.expiresAt > now) {
    return builtinCache.prompts;
  }
  const prompts = readBuiltinPrompts();
  builtinCache = { prompts, expiresAt: now + BUILTIN_CACHE_TTL_MS };
  return prompts;
}

export function listBenchmarkPrompts(): BenchmarkPromptWithSource[] {
  const builtin = listBuiltinBenchmarkPrompts().map((prompt) => ({
    ...prompt,
    source: "builtin" as const,
  }));
  const builtinIds = new Set(builtin.map((prompt) => prompt.id));
  const custom = listCustomBenchmarkPrompts()
    .filter((prompt) => !builtinIds.has(prompt.id))
    .map((prompt) => ({ ...prompt, source: "custom" as const }));
  return [...builtin, ...custom];
}

export function listBenchmarkPromptMetas(): BenchmarkPromptMeta[] {
  return listBenchmarkPrompts().map(({ messages: _messages, ...meta }) => meta);
}

export function getBenchmarkPrompt(
  id: string,
): BenchmarkPromptWithSource | null {
  return listBenchmarkPrompts().find((prompt) => prompt.id === id) ?? null;
}

export function createBenchmarkPrompt(
  input: BenchmarkPromptCreate,
): BenchmarkPrompt {
  const id = input.id ?? newId();
  if (getBenchmarkPrompt(id)) {
    throw new BenchmarkConflictError(`benchmark prompt ${id} already exists`);
  }
  return createCustomBenchmarkPrompt({ ...input, id });
}

export function updateBenchmarkPrompt(
  id: string,
  update: BenchmarkPromptUpdate,
): BenchmarkPrompt | null {
  if (listBuiltinBenchmarkPrompts().some((prompt) => prompt.id === id)) {
    throw new BenchmarkConflictError(
      `benchmark prompt ${id} is builtin and cannot be edited`,
    );
  }
  return updateCustomBenchmarkPrompt(id, update);
}

export function deleteBenchmarkPrompt(id: string): boolean {
  if (listBuiltinBenchmarkPrompts().some((prompt) => prompt.id === id)) {
    throw new BenchmarkConflictError(
      `benchmark prompt ${id} is builtin and cannot be deleted`,
    );
  }
  return deleteCustomBenchmarkPrompt(id);
}
