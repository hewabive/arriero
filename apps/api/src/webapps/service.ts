import {
  isActiveProcessStatus,
  webappDescriptor,
  type WebappConfigRecord,
  type WebappPreflightIssue,
} from "@arriero/core";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getEnvironmentRecord } from "../envs/service.js";
import { logger } from "../logger.js";
import { getWebappRecord, listWebappRecords } from "./config-files.js";
import {
  buildWebappLaunchSnapshot,
  parseWebappLaunchSnapshot,
  serializeWebappLaunchSnapshot,
} from "./launch.js";
import { webappDataDir } from "./paths.js";
import { checkWebappStartPreflight } from "./preflight.js";
import { latestWebappRun, listOpenWebappRuns } from "./runs-repository.js";
import { ensureWebappSecretKey } from "./secrets.js";
import { stopStaleWebapp } from "./stale.js";
import { webappSupervisor, type WebappRuntimeState } from "./supervisor.js";

export class WebappStartBlockedError extends Error {
  constructor(readonly issues: WebappPreflightIssue[]) {
    super(
      issues
        .filter((issue) => issue.level === "error")
        .map((issue) => issue.message)
        .join("; ") || "webapp start blocked",
    );
    this.name = "WebappStartBlockedError";
  }
}

function backupBeforeEnvSwitch(record: WebappConfigRecord): void {
  const snapshot = parseWebappLaunchSnapshot(
    latestWebappRun(record.name)?.launchSnapshot,
  );
  if (!snapshot || snapshot.envSpecId === record.envSpecId) {
    return;
  }
  const dataDir = webappDataDir(record.name);
  const suffix = snapshot.envSpecId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  for (const file of webappDescriptor(record.kind).upgradeBackupFiles) {
    const source = resolve(dataDir, file);
    if (!existsSync(source)) {
      continue;
    }
    const backup = `${source}.bak-${suffix}`;
    copyFileSync(source, backup);
    logger.info(
      { webapp: record.name, source, backup },
      "webapp environment changed; backed up data file before start",
    );
  }
}

export async function startWebapp(
  name: string,
): Promise<WebappRuntimeState | null> {
  const record = getWebappRecord(name);
  if (!record) {
    return null;
  }
  const current = webappSupervisor.getState(name);
  if (current && isActiveProcessStatus(current.status)) {
    return current;
  }

  const environment = getEnvironmentRecord(record.envSpecId);
  const issues = await checkWebappStartPreflight(record, environment);
  if (issues.some((issue) => issue.level === "error")) {
    throw new WebappStartBlockedError(issues);
  }

  ensureWebappSecretKey(name);
  mkdirSync(webappDataDir(name), { recursive: true });
  backupBeforeEnvSwitch(record);

  const { snapshot, env } = buildWebappLaunchSnapshot(
    record,
    environment!.entrypoint,
  );
  return webappSupervisor.launch({
    name,
    kind: record.kind,
    binaryPath: snapshot.binaryPath,
    args: snapshot.cliArgs,
    cwd: snapshot.cwd,
    env: { ...process.env, ...env },
    serializedSnapshot: serializeWebappLaunchSnapshot(snapshot),
  });
}

export async function stopWebapp(
  name: string,
  timeoutMs = 10_000,
): Promise<WebappRuntimeState | null> {
  const stopped = webappSupervisor.stop(name, "operator", timeoutMs);
  if (stopped) {
    return stopped;
  }
  await stopStaleWebapp(name, "operator", timeoutMs);
  return webappSupervisor.getState(name) ?? null;
}

export async function stopWebappForDelete(name: string): Promise<void> {
  webappSupervisor.stop(name, "delete", 2_000);
  await webappSupervisor.waitForStopped(name, 2_500);
  await stopStaleWebapp(name, "delete", 2_000);
}

export async function restartWebapp(
  name: string,
): Promise<WebappRuntimeState | null> {
  const runtime = webappSupervisor.getState(name);
  if (runtime && isActiveProcessStatus(runtime.status)) {
    webappSupervisor.stop(name, "operator", 5_000);
    await webappSupervisor.waitForStopped(name, 7_000);
  }
  return startWebapp(name);
}

export async function autostartWebapps(): Promise<{
  started: number;
  failed: number;
}> {
  const openRunNames = new Set(listOpenWebappRuns().map((run) => run.webappId));
  const summary = { started: 0, failed: 0 };
  for (const record of listWebappRecords()) {
    if (!record.autostart || openRunNames.has(record.name)) {
      continue;
    }
    const runtime = webappSupervisor.getState(record.name);
    if (runtime && isActiveProcessStatus(runtime.status)) {
      continue;
    }
    try {
      await startWebapp(record.name);
      summary.started += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error(
        { err: error, webapp: record.name },
        "webapp autostart failed",
      );
    }
  }
  return summary;
}
