import {
  defaultWebappSettings,
  isActiveProcessStatus,
  webappDescriptor,
  WebappConfigRecordSchema,
  type Webapp,
  type WebappConfigRecord,
  type WebappCreate,
  type WebappUpdate,
} from "@arriero/core";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { getEnvironmentRecord } from "../envs/service.js";
import { logger } from "../logger.js";
import {
  getWebappRecord,
  listWebappRecords,
  removeWebappRecord,
  writeWebappRecord,
} from "./config-files.js";
import { hasWebappLaunchDrift, parseWebappLaunchSnapshot } from "./launch.js";
import {
  discardWebappDirectory,
  webappDataDir,
  webappLogFilePattern,
} from "./paths.js";
import {
  deleteWebappRuns,
  latestWebappRun,
  listWebappRunLogPaths,
  openWebappRun,
  renameWebappRuns,
} from "./runs-repository.js";
import { deleteWebappSecret, renameWebappSecret } from "./secrets.js";
import { webappSupervisor } from "./supervisor.js";

export class WebappNameConflictError extends Error {
  constructor(name: string) {
    super(`webapp name already exists: ${name}`);
    this.name = "WebappNameConflictError";
  }
}

export class WebappConfigValidationError extends Error {
  constructor(readonly details: unknown) {
    super("webapp configuration is invalid");
    this.name = "WebappConfigValidationError";
  }
}

export class WebappUpdateBlockedError extends Error {
  constructor(name: string, field: string, status: string) {
    super(`stop webapp ${name} before changing ${field} (status: ${status})`);
    this.name = "WebappUpdateBlockedError";
  }
}

function validateRecord(record: WebappConfigRecord): WebappConfigRecord {
  const parsed = WebappConfigRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new WebappConfigValidationError(parsed.error.flatten());
  }
  return parsed.data;
}

function activeRunStatus(name: string): string | null {
  const runtime = webappSupervisor.getState(name);
  if (runtime && isActiveProcessStatus(runtime.status)) {
    return runtime.status;
  }
  return openWebappRun(name)?.status ?? null;
}

function assertWebappFieldChangeAllowed(name: string, field: string): void {
  const status = activeRunStatus(name);
  if (status) {
    throw new WebappUpdateBlockedError(name, field, status);
  }
}

function latestStatus(name: string): Pick<Webapp, "status" | "pid"> {
  const latestRun = latestWebappRun(name);
  const knownStatuses = new Set<Webapp["status"]>([
    "stopped",
    "starting",
    "running",
    "stopping",
    "exited",
    "stale",
    "error",
  ]);
  const status =
    latestRun && knownStatuses.has(latestRun.status as Webapp["status"])
      ? (latestRun.status as Webapp["status"])
      : "stopped";
  const pid = latestRun?.pid ? Number(latestRun.pid) : null;
  return {
    status,
    pid: pid && Number.isFinite(pid) ? pid : null,
  };
}

function detectConfigDrift(
  record: WebappConfigRecord,
  status: Webapp["status"],
  entrypoint: string | null,
): boolean {
  if (!entrypoint || !isActiveProcessStatus(status)) {
    return false;
  }
  const snapshot = parseWebappLaunchSnapshot(
    latestWebappRun(record.name)?.launchSnapshot,
  );
  if (!snapshot) {
    return false;
  }
  return hasWebappLaunchDrift(record, entrypoint, snapshot);
}

function toWebapp(record: WebappConfigRecord): Webapp {
  const runtime = webappSupervisor.getState(record.name);
  const durable = latestStatus(record.name);
  const status = runtime?.status ?? durable.status;
  const environment = getEnvironmentRecord(record.envSpecId);

  return {
    ...record,
    status,
    pid: runtime?.pid ?? durable.pid,
    envStatus: environment?.status ?? "missing-spec",
    envVersion: environment?.version ?? null,
    configDrift: detectConfigDrift(
      record,
      status,
      environment?.entrypoint ?? null,
    ),
  };
}

export function listWebapps(): Webapp[] {
  return listWebappRecords().map(toWebapp);
}

export function getWebapp(name: string): Webapp | null {
  const record = getWebappRecord(name);
  return record ? toWebapp(record) : null;
}

export function createWebapp(
  input: WebappCreate,
  proxySourceId: string | null,
): Webapp {
  if (getWebappRecord(input.name)) {
    throw new WebappNameConflictError(input.name);
  }
  const descriptor = webappDescriptor(input.kind);
  const record: WebappConfigRecord = {
    name: input.name,
    kind: input.kind,
    envSpecId: input.envSpecId,
    http: input.http ?? {
      host: descriptor.http.defaultHost,
      port: descriptor.http.defaultPort,
    },
    proxySourceId,
    autostart: input.autostart,
    settings: input.settings ?? defaultWebappSettings(input.kind),
  };
  const validated = validateRecord(record);
  writeWebappRecord(validated);
  return toWebapp(validated);
}

function renameDataDir(from: string, to: string): void {
  const fromDir = webappDataDir(from);
  if (!existsSync(fromDir)) {
    return;
  }
  const toDir = webappDataDir(to);
  if (existsSync(toDir)) {
    logger.warn(
      { from: fromDir, to: toDir },
      "webapp rename: data directory move skipped, destination exists",
    );
    return;
  }
  try {
    renameSync(fromDir, toDir);
  } catch (error) {
    logger.warn(
      { err: error, from: fromDir, to: toDir },
      "webapp rename: data directory move failed",
    );
  }
}

export function updateWebapp(name: string, input: WebappUpdate): Webapp | null {
  const current = getWebappRecord(name);
  if (!current) {
    return null;
  }

  const nextName = input.name ?? current.name;
  if (nextName !== current.name) {
    if (getWebappRecord(nextName)) {
      throw new WebappNameConflictError(nextName);
    }
    assertWebappFieldChangeAllowed(current.name, "name");
  }
  const nextEnvSpecId = input.envSpecId ?? current.envSpecId;
  if (nextEnvSpecId !== current.envSpecId) {
    assertWebappFieldChangeAllowed(current.name, "envSpecId");
  }

  const record: WebappConfigRecord = {
    name: nextName,
    kind: current.kind,
    envSpecId: nextEnvSpecId,
    http: input.http ?? current.http,
    proxySourceId:
      input.proxySourceId !== undefined
        ? input.proxySourceId
        : current.proxySourceId,
    autostart: input.autostart ?? current.autostart,
    settings: input.settings ?? current.settings,
  };

  const validated = validateRecord(record);
  writeWebappRecord(validated, current.name);
  if (validated.name !== current.name) {
    renameWebappRuns(current.name, validated.name);
    renameWebappSecret(current.name, validated.name);
    renameDataDir(current.name, validated.name);
  }
  return toWebapp(validated);
}

function removeLogFiles(name: string, recordedPaths: string[]): void {
  const paths = new Set(recordedPaths);
  const filePattern = webappLogFilePattern(name);
  const logsDir = resolve(config.logsDir, "webapps");
  if (existsSync(logsDir)) {
    for (const entry of readdirSync(logsDir)) {
      if (filePattern.test(entry)) {
        paths.add(resolve(logsDir, entry));
      }
    }
  }
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      logger.warn({ err: error, path }, "webapp delete: log removal failed");
    }
  }
}

export function deleteWebapp(name: string): boolean {
  const recordedLogPaths = listWebappRunLogPaths(name);
  const removed = removeWebappRecord(name);
  if (removed) {
    deleteWebappRuns(name);
    deleteWebappSecret(name);
    removeLogFiles(name, recordedLogPaths);
    try {
      discardWebappDirectory(resolve(config.webappsDir, name));
    } catch (error) {
      logger.warn(
        { err: error, name },
        "webapp delete: data directory removal failed",
      );
    }
  }
  return removed;
}
