import type { AppRestartResult, AppVersion } from "@arriero/core";

import { updateAdapter } from "./adapter.js";
import { getAppVersion } from "./version.js";

const RESTART_DELAY_MS = 800;

const appStartedAt = new Date().toISOString();

let restartScheduled = false;

export function withStartedAt(version: AppVersion): AppVersion {
  return { ...version, startedAt: appStartedAt };
}

export function appVersionWithStartedAt(): AppVersion {
  return withStartedAt(getAppVersion());
}

export function restartBlockedReason(version: AppVersion): string | null {
  if (!version.supervised) {
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
  const fire = () => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      process.exit(0);
    }
  };
  void updateAdapter.beforeRestart().finally(() => {
    setTimeout(fire, RESTART_DELAY_MS).unref?.();
  });
  return result;
}
