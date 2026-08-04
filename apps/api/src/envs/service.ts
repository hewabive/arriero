import {
  EnvironmentCreateSchema,
  EnvironmentRecordSchema,
  type EnvironmentCreate,
  type EnvironmentRecord,
  type EnvironmentSpec,
} from "@arriero/core";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { listInstances } from "../instances/repository.js";
import { deletePathCatalogEntry } from "../path-catalog/repository.js";
import { reconcileEnvironmentCatalog } from "./catalog.js";
import {
  assertEnvironmentPath,
  environmentDirectory,
  environmentEntrypoint,
  environmentStagingDirectory,
} from "./paths.js";
import {
  createEnvironmentSpec,
  deleteEnvironmentSpec,
  getEnvironmentSpec,
  listEnvironmentJobs,
  listEnvironmentSpecs,
} from "./repository.js";
import { environmentRunner } from "./runner.js";
import { uvCompatibilityError } from "./uv.js";
import { environmentLayoutError } from "./validation.js";
import { rocmDeviceAvailable } from "./availability.js";
import { environmentProvisioner } from "./provisioners.js";
import { getSystemAccelerators } from "../system/resources.js";

function latestJob(spec: EnvironmentSpec) {
  return (
    listEnvironmentJobs(100).find((job) => job.environmentId === spec.id) ??
    null
  );
}

function toRecord(spec: EnvironmentSpec): EnvironmentRecord {
  const path = environmentDirectory(spec);
  const entrypoint = environmentEntrypoint(spec);
  const job = latestJob(spec);
  const installed = existsSync(entrypoint);
  const layoutError = installed ? environmentLayoutError(spec) : null;
  const status =
    job?.status === "running"
      ? "installing"
      : installed && !layoutError
        ? "installed"
        : job?.status === "failed" || job?.status === "canceled"
          ? "failed"
          : "missing";
  const error =
    status === "failed"
      ? (layoutError ?? job?.error ?? "installation failed")
      : null;
  const availability = environmentProvisioner(spec.engine).availability(spec, {
    accelerators: getSystemAccelerators(),
    installed: status === "installed",
    rocmDeviceAvailable: rocmDeviceAvailable(),
  });
  return EnvironmentRecordSchema.parse({
    ...spec,
    status,
    path,
    entrypoint,
    error,
    ...availability,
  });
}

export function listEnvironments() {
  return listEnvironmentSpecs().map((spec) => {
    if (
      existsSync(environmentEntrypoint(spec)) &&
      !environmentLayoutError(spec)
    ) {
      reconcileEnvironmentCatalog(spec);
      return toRecord(getEnvironmentSpec(spec.id) ?? spec);
    }
    return toRecord(spec);
  });
}

function assertCanStart() {
  const uvError = uvCompatibilityError();
  if (uvError) throw new Error(uvError);
  if (environmentRunner.activeEnvironmentId()) {
    throw new Error("another environment installation is already running");
  }
}

export function createEnvironment(input: EnvironmentCreate) {
  const parsed = EnvironmentCreateSchema.parse(input);
  assertCanStart();
  const spec = createEnvironmentSpec(parsed);
  return { environment: toRecord(spec), job: environmentRunner.start(spec) };
}

export function rebuildEnvironment(id: string) {
  const spec = getEnvironmentSpec(id);
  if (!spec) return null;
  assertCanStart();
  if (existsSync(environmentDirectory(spec))) {
    throw new Error("environment is already installed");
  }
  return { environment: toRecord(spec), job: environmentRunner.start(spec) };
}

export function deleteEnvironment(id: string) {
  const spec = getEnvironmentSpec(id);
  if (!spec) return false;
  if (environmentRunner.activeEnvironmentId() === id) {
    throw new Error("environment installation is running");
  }
  if (
    spec.pathCatalogEntryId &&
    listInstances().some(
      (instance) => instance.binaryPathRefId === spec.pathCatalogEntryId,
    )
  ) {
    throw new Error("environment is used by an instance");
  }
  rmSync(assertEnvironmentPath(environmentDirectory(spec)), {
    recursive: true,
    force: true,
  });
  rmSync(assertEnvironmentPath(environmentStagingDirectory(spec)), {
    recursive: true,
    force: true,
  });
  if (spec.pathCatalogEntryId) deletePathCatalogEntry(spec.pathCatalogEntryId);
  return deleteEnvironmentSpec(id);
}

export function initializeEnvironments() {
  let swept = 0;
  for (const entry of readdirSync(config.envsDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".staging")) continue;
    rmSync(assertEnvironmentPath(resolve(config.envsDir, entry.name)), {
      recursive: true,
      force: true,
    });
    swept += 1;
  }
  const records = listEnvironments();
  const installed = records.filter(
    (item) => item.status === "installed",
  ).length;
  return { specs: records.length, installed, ready: installed, swept };
}
