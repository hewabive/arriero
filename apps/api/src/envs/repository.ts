import {
  EnvironmentSpecSchema,
  type EnvironmentCreate,
  type EnvironmentJob,
  type EnvironmentJobStatus,
  type EnvironmentJobStep,
  type EnvironmentJobStepName,
  type EnvironmentSpec,
} from "@llama-manager/core";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { newId } from "../utils/id.js";

export const ENVIRONMENTS_FILE = resolve(config.configDir, "envs.json");
let cache: EnvironmentSpec[] | null = null;
const jobs = new Map<string, EnvironmentJob>();

function nowIso() {
  return new Date().toISOString();
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function load() {
  if (cache) return cache;
  if (!existsSync(ENVIRONMENTS_FILE)) {
    cache = [];
    return cache;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(ENVIRONMENTS_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${ENVIRONMENTS_FILE}: ${(error as Error).message}`);
  }
  const parsed = z.array(EnvironmentSpecSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid config in ${ENVIRONMENTS_FILE}: ${parsed.error.message}`);
  }
  cache = parsed.data;
  return cache;
}

function persist(specs: EnvironmentSpec[]) {
  const sorted = [...specs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  atomicWrite(ENVIRONMENTS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  cache = sorted;
}

export function listEnvironmentSpecs() {
  return [...load()];
}

export function getEnvironmentSpec(id: string) {
  return load().find((spec) => spec.id === id) ?? null;
}

export function createEnvironmentSpec(input: EnvironmentCreate) {
  const timestamp = nowIso();
  const spec = EnvironmentSpecSchema.parse({
    ...input,
    id: newId(),
    pathCatalogEntryId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  persist([...load(), spec]);
  return spec;
}

export function updateEnvironmentSpec(
  id: string,
  patch: Partial<Pick<EnvironmentSpec, "pathCatalogEntryId">>,
) {
  const current = getEnvironmentSpec(id);
  if (!current) return null;
  const next = EnvironmentSpecSchema.parse({ ...current, ...patch, updatedAt: nowIso() });
  persist(load().map((spec) => (spec.id === id ? next : spec)));
  return next;
}

export function deleteEnvironmentSpec(id: string) {
  const next = load().filter((spec) => spec.id !== id);
  if (next.length === load().length) return false;
  persist(next);
  return true;
}

export function createEnvironmentJob(input: {
  environmentId: string;
  steps: EnvironmentJobStep[];
  logPath: string;
}): EnvironmentJob {
  const job: EnvironmentJob = {
    id: newId(),
    environmentId: input.environmentId,
    status: "running",
    steps: input.steps,
    currentStep: null,
    startedAt: nowIso(),
    finishedAt: null,
    logPath: input.logPath,
    error: null,
  };
  jobs.set(job.id, structuredClone(job));
  return structuredClone(job);
}

export function updateEnvironmentJob(
  id: string,
  patch: Partial<{
    status: EnvironmentJobStatus;
    steps: EnvironmentJobStep[];
    currentStep: EnvironmentJobStepName | null;
    finishedAt: string | null;
    error: string | null;
  }>,
) {
  const current = jobs.get(id);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    currentStep: patch.currentStep === undefined ? current.currentStep : patch.currentStep,
    finishedAt: patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
    error: patch.error === undefined ? current.error : patch.error,
  };
  jobs.set(id, structuredClone(next));
  return structuredClone(next);
}

export function getEnvironmentJob(id: string) {
  const job = jobs.get(id);
  return job ? structuredClone(job) : null;
}

export function listEnvironmentJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map((job) => structuredClone(job));
}

export function resetEnvironmentRepository() {
  cache = null;
  jobs.clear();
}
