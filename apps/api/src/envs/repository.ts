import {
  ENVIRONMENT_MACHINE_STATE_KEYS,
  EnvironmentMachineStateSchema,
  EnvironmentSpecSchema,
  type EnvironmentCreate,
  type EnvironmentJob,
  type EnvironmentJobStatus,
  type EnvironmentJobStep,
  type EnvironmentJobStepName,
  type EnvironmentMachineStateEntry,
  type EnvironmentSpec,
} from "@arriero/core";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";
import { createJobStore } from "../jobs/store.js";
import { isPathWithin } from "../path-utils.js";
import { newId } from "../utils/id.js";
import { sortedByKey } from "../utils/sort.js";
import { environmentDirectory } from "./paths.js";

export const ENVIRONMENTS_FILE = resolve(config.configDir, "envs.json");
export const ENVIRONMENTS_STATE_FILE = resolve(
  config.configDir,
  "envs-state.json",
);
const ENVIRONMENT_JOB_HISTORY_LIMIT = 20;

const store = createJsonFileStore<EnvironmentSpec[]>({
  id: "environments",
  path: ENVIRONMENTS_FILE,
  schema: z.array(EnvironmentSpecSchema),
  missing: () => [],
  portablePaths: false,
  cache: "process",
});

const stateStore = createJsonFileStore<EnvironmentMachineStateEntry[]>({
  id: "environments-state",
  path: ENVIRONMENTS_STATE_FILE,
  schema: EnvironmentMachineStateSchema,
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
  store.write(sortedByKey(specs, (spec) => spec.id));
}

function loadState() {
  return stateStore.read();
}

function persistState(entries: EnvironmentMachineStateEntry[]) {
  stateStore.write(sortedByKey(entries, (entry) => entry.envId));
}

export function environmentRowsHaveMachineKeys(json: unknown): boolean {
  return (
    Array.isArray(json) &&
    json.some(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        ENVIRONMENT_MACHINE_STATE_KEYS.some((key) => key in row),
    )
  );
}

export function getEnvironmentMachineState(
  envId: string,
): EnvironmentMachineStateEntry | null {
  return loadState().find((entry) => entry.envId === envId) ?? null;
}

export function setEnvironmentPathCatalogEntryId(
  envId: string,
  pathCatalogEntryId: string | null,
): void {
  const timestamp = nowIso();
  const entries = loadState();
  const current = entries.find((entry) => entry.envId === envId);
  if (current) {
    if (current.pathCatalogEntryId === pathCatalogEntryId) {
      return;
    }
    persistState(
      entries.map((entry) =>
        entry.envId === envId
          ? { ...entry, pathCatalogEntryId, updatedAt: timestamp }
          : entry,
      ),
    );
    return;
  }
  persistState([
    ...entries,
    { envId, pathCatalogEntryId, createdAt: timestamp, updatedAt: timestamp },
  ]);
}

export function pruneEnvironmentMachineState(): void {
  const specIds = new Set(load().map((spec) => spec.id));
  const entries = loadState();
  const next = entries.filter((entry) => specIds.has(entry.envId));
  if (next.length !== entries.length) {
    persistState(next);
  }
}

export function rewriteEnvironmentsFile(): void {
  persist(load());
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
    load().find((spec) => isPathWithin(environmentDirectory(spec), resolved)) ??
    null
  );
}

export function createEnvironmentSpec(input: EnvironmentCreate) {
  const spec = EnvironmentSpecSchema.parse({
    ...input,
    id: newId(),
  });
  persist([...load(), spec]);
  setEnvironmentPathCatalogEntryId(spec.id, null);
  return spec;
}

export function deleteEnvironmentSpec(id: string) {
  const next = load().filter((spec) => spec.id !== id);
  if (next.length === load().length) return false;
  persist(next);
  pruneEnvironmentMachineState();
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
  stateStore.reset();
  environmentJobs.clear();
}
