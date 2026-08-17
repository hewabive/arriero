import {
  EnvironmentSpecSchema,
  type EnvironmentCreate,
  type EnvironmentJob,
  type EnvironmentJobStatus,
  type EnvironmentJobStep,
  type EnvironmentJobStepName,
  type EnvironmentSpec,
} from "@arriero/core";
import { resolve, sep } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import { createJobStore } from "../jobs/store.js";
import { newId } from "../utils/id.js";
import { environmentDirectory } from "./paths.js";

export const ENVIRONMENTS_FILE = resolve(config.configDir, "envs.json");
const ENVIRONMENT_JOB_HISTORY_LIMIT = 20;

const store = createJsonFileStore<EnvironmentSpec[]>({
  id: "environments",
  path: ENVIRONMENTS_FILE,
  schema: z.array(EnvironmentSpecSchema),
  missing: () => [],
  portablePaths: false,
  cache: "process",
});

export const environmentJobs = createJobStore<EnvironmentJob>({
  historyLimit: ENVIRONMENT_JOB_HISTORY_LIMIT,
});

function nowIso() {
  return new Date().toISOString();
}

function load() {
  return store.read();
}

function persist(specs: EnvironmentSpec[]) {
  const sorted = [...specs].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  store.write(sorted);
}

export function listEnvironmentSpecs() {
  return [...load()];
}

export function getEnvironmentSpec(id: string) {
  return load().find((spec) => spec.id === id) ?? null;
}

export function environmentSpecForBinaryPath(binaryPath: string) {
  const resolved = resolve(binaryPath);
  return (
    load().find((spec) => {
      const directory = environmentDirectory(spec);
      return (
        resolved === directory || resolved.startsWith(`${directory}${sep}`)
      );
    }) ?? null
  );
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
  const next = EnvironmentSpecSchema.parse({
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
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
  return environmentJobs.insert({
    id: newId(),
    environmentId: input.environmentId,
    status: "running",
    steps: input.steps,
    currentStep: null,
    startedAt: nowIso(),
    finishedAt: null,
    logPath: input.logPath,
    error: null,
  });
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
  return environmentJobs.patch(id, patch);
}

export function getEnvironmentJob(id: string) {
  return environmentJobs.get(id);
}

export function listEnvironmentJobs(limit = 20) {
  return environmentJobs.list(limit);
}

export function resetEnvironmentRepository() {
  store.reset();
  environmentJobs.clear();
}
