import type { AppRestartResult, AppVersion } from "@arriero/core";

import {
  buildSyncFlags,
  readDistBuildCommit,
  runningBuildCommit,
} from "./build-info.js";
import { scheduleProcessRestart } from "./runner.js";
import { getAppVersion } from "./version.js";

const appStartedAt = new Date().toISOString();

let restartScheduled = false;

export function withRuntimeInfo(version: AppVersion): AppVersion {
  const builtCommit = readDistBuildCommit();
  const runningCommit = runningBuildCommit();
  return {
    ...version,
    startedAt: appStartedAt,
    builtCommit,
    runningCommit,
    ...buildSyncFlags({
      headCommit: version.commit,
      distCommit: builtCommit,
      runningCommit,
    }),
  };
}

export function appVersionWithRuntimeInfo(): AppVersion {
  return withRuntimeInfo(getAppVersion());
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
