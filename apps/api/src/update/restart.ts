import type { AppRestartResult, AppVersion } from "@arriero/core";

import { scheduleProcessRestart } from "./runner.js";
import { getAppVersion } from "./version.js";

const appStartedAt = new Date().toISOString();

let restartScheduled = false;

export function withStartedAt(version: AppVersion): AppVersion {
  return { ...version, startedAt: appStartedAt };
}

export function appVersionWithStartedAt(): AppVersion {
  return withStartedAt(getAppVersion());
}

export function restartBlockedReason(supervised: boolean): string | null {
  if (!supervised) {
    return "no supervisor detected; a restart would stop the process without bringing it back — restart it from the shell instead";
  }
  return null;
}

export function scheduleAppRestart(): AppRestartResult {
  const result: AppRestartResult = {
    restarting: true,
    startedAt: appStartedAt,
  };
  if (restartScheduled) {
    return result;
  }
  restartScheduled = true;
  scheduleProcessRestart();
  return result;
}
