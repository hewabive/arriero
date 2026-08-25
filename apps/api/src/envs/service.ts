import {
  EnvironmentCreateSchema,
  EnvironmentRecordSchema,
  type EnvironmentCreate,
  type EnvironmentRecord,
  type EnvironmentSpec,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { listInstances } from "../instances/repository.js";
import { listWebappRecords } from "../webapps/config-files.js";
import { deletePathCatalogEntry } from "../path-catalog/repository.js";
import { reconcileEnvironmentCatalog } from "./catalog.js";
import { discardDirectory } from "../utils/discard.js";
import { sweepEnvironmentLeftovers } from "./discard.js";
import {
  assertEnvironmentPath,
  environmentDirectory,
  environmentEntrypoint,
  environmentStagingDirectory,
} from "./paths.js";
import {
  createEnvironmentSpec,
  deleteEnvironmentSpec,
  getEnvironmentMachineState,
  getEnvironmentSpec,
  listEnvironmentJobs,
  listEnvironmentSpecs,
  pruneEnvironmentMachineState,
} from "./repository.js";
import { environmentRunner } from "./runner.js";
import { probeUv } from "./uv.js";
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
    createdAt: getEnvironmentMachineState(spec.id)?.createdAt ?? null,
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
    }
    return toRecord(spec);
  });
}

export function getEnvironmentRecord(id: string): EnvironmentRecord | null {
  const spec = getEnvironmentSpec(id);
  return spec ? toRecord(spec) : null;
}

function assertCanStart(): string {
  const uv = probeUv();
  if (uv.error !== null) throw new Error(uv.error);
  if (environmentRunner.activeEnvironmentId()) {
    throw new Error("another environment installation is already running");
  }
  return uv.path;
}

export function createEnvironment(input: EnvironmentCreate) {
  const parsed = EnvironmentCreateSchema.parse(input);
  const uv = assertCanStart();
  const spec = createEnvironmentSpec(parsed);
  return {
    environment: toRecord(spec),
    job: environmentRunner.start(spec, uv),
  };
}

export function rebuildEnvironment(id: string) {
  const spec = getEnvironmentSpec(id);
  if (!spec) return null;
  const uv = assertCanStart();
  if (
    existsSync(environmentEntrypoint(spec)) &&
    !environmentLayoutError(spec)
  ) {
    throw new Error("environment is already installed");
  }
  discardDirectory(assertEnvironmentPath(environmentDirectory(spec)));
  return {
    environment: toRecord(spec),
    job: environmentRunner.start(spec, uv),
  };
}

export function deleteEnvironment(id: string) {
  const spec = getEnvironmentSpec(id);
  if (!spec) return false;
  if (environmentRunner.activeEnvironmentId() === id) {
    throw new Error("environment installation is running");
  }
  const pathCatalogEntryId =
    getEnvironmentMachineState(spec.id)?.pathCatalogEntryId ?? null;
  if (
    pathCatalogEntryId &&
    listInstances().some(
      (instance) => instance.binaryPathRefId === pathCatalogEntryId,
    )
  ) {
    throw new Error("environment is used by an instance");
  }
  if (listWebappRecords().some((webapp) => webapp.envSpecId === spec.id)) {
    throw new Error("environment is used by a webapp");
  }
  discardDirectory(assertEnvironmentPath(environmentDirectory(spec)));
  discardDirectory(assertEnvironmentPath(environmentStagingDirectory(spec)));
  if (pathCatalogEntryId) deletePathCatalogEntry(pathCatalogEntryId);
  return deleteEnvironmentSpec(id);
}

export function initializeEnvironments() {
  const swept = sweepEnvironmentLeftovers();
  pruneEnvironmentMachineState();
  const records = listEnvironments();
  const installed = records.filter(
    (item) => item.status === "installed",
  ).length;
  return { specs: records.length, installed, ready: installed, swept };
}
