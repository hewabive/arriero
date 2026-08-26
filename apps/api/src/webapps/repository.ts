import {
  defaultWebappSettings,
  isActiveProcessStatus,
  webappDescriptor,
  WebappConfigRecordSchema,
  WebappRuntimeStatusSchema,
  type EnvironmentRecord,
  type Webapp,
  type WebappConfigRecord,
  type WebappCreate,
  type WebappUpdate,
} from "@arriero/core";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { getEnvironmentRecord } from "../envs/service.js";
import { logger } from "../logger.js";
import { runLogFilePattern } from "../process/log-paths.js";
import { parsePidText } from "../process/pid.js";
import { discardDirectory } from "../utils/discard.js";
import {
  getWebappRecord,
  listWebappRecords,
  removeWebappRecord,
  writeWebappRecord,
} from "./config-files.js";
import {
  parseWebappLaunchSnapshot,
  webappLaunchDriftFields,
} from "./launch.js";
import { webappDataDir, webappLogsDir } from "./paths.js";
import {
  deleteWebappRuns,
  latestWebappRun,
  listWebappRunLogPaths,
  openWebappRun,
  renameWebappRuns,
  type WebappRun,
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

function latestStatus(
  latestRun: WebappRun | null,
): Pick<Webapp, "status" | "pid"> {
  const parsed = WebappRuntimeStatusSchema.safeParse(latestRun?.status);
  return {
    status: parsed.success ? parsed.data : "stopped",
    pid: latestRun ? parsePidText(latestRun.pid) : null,
  };
}

function detectConfigDrift(
  record: WebappConfigRecord,
  status: Webapp["status"],
  entrypoint: string | null,
  latestRun: WebappRun | null,
): Webapp["configDrift"] {
  if (!entrypoint || !isActiveProcessStatus(status)) {
    return [];
  }
  const snapshot = parseWebappLaunchSnapshot(latestRun?.launchSnapshot);
  if (!snapshot) {
    return [];
  }
  return webappLaunchDriftFields(record, entrypoint, snapshot);
}

function toWebapp(
  record: WebappConfigRecord,
  environmentFor: (
    envSpecId: string,
  ) => EnvironmentRecord | null = getEnvironmentRecord,
): Webapp {
  const runtime = webappSupervisor.getState(record.name);
  const latestRun = latestWebappRun(record.name);
  const durable = latestStatus(latestRun);
  const status = runtime?.status ?? durable.status;
  const environment = environmentFor(record.envSpecId);

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
      latestRun,
    ),
  };
}

export function listWebapps(): Webapp[] {
  const environments = new Map<string, EnvironmentRecord | null>();
  const environmentFor = (envSpecId: string) => {
    let environment = environments.get(envSpecId);
    if (environment === undefined) {
      environment = getEnvironmentRecord(envSpecId);
      environments.set(envSpecId, environment);
    }
    return environment;
  };
  return listWebappRecords().map((record) => toWebapp(record, environmentFor));
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
  const filePattern = runLogFilePattern(name);
  const logsDir = webappLogsDir();
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
      discardDirectory(webappDataDir(name));
    } catch (error) {
      logger.warn(
        { err: error, name },
        "webapp delete: data directory removal failed",
      );
    }
  }
  return removed;
}
