import { basename, dirname, join } from "node:path";

import { parseSplitInfo, splitShardName } from "@arriero/core";
import { parseLaunchSnapshot } from "../process/launch-snapshot.js";
import { listLiveOpenProcessRuns } from "../process/live-runs.js";

export type HfDeleteScope = {
  dir: string;
  paths: readonly string[] | null;
};

export type LiveProcessArgs = {
  instanceId: string;
  cliArgs: string[];
};

function addSplitGroupShards(absolutePath: string, into: Set<string>): void {
  const split = parseSplitInfo(basename(absolutePath));
  if (!split) {
    return;
  }
  const directory = dirname(absolutePath);
  for (let index = 1; index <= split.count; index += 1) {
    into.add(join(directory, splitShardName(split, index, split.count)));
  }
}

function deleteTargetPaths(scope: HfDeleteScope): Set<string> | null {
  if (!scope.paths) {
    return null;
  }
  const targets = new Set<string>();
  for (const path of scope.paths) {
    const absolute = join(scope.dir, path);
    targets.add(absolute);
    addSplitGroupShards(absolute, targets);
  }
  return targets;
}

function mentionsExactDir(arg: string, dir: string): boolean {
  const trimmed = arg.endsWith("/") ? arg.slice(0, -1) : arg;
  return trimmed === dir || trimmed.endsWith(`=${dir}`);
}

export function hfDeleteBlockers(
  scope: HfDeleteScope,
  processes: LiveProcessArgs[],
): string[] {
  const targets = deleteTargetPaths(scope);
  const dirPrefix = `${scope.dir}/`;
  const references = (arg: string) => {
    if (mentionsExactDir(arg, scope.dir)) {
      return true;
    }
    return targets
      ? [...targets].some((target) => arg.includes(target))
      : arg.includes(dirPrefix);
  };
  const blockers = new Set<string>();
  for (const process of processes) {
    if (process.cliArgs.some(references)) {
      blockers.add(process.instanceId);
    }
  }
  return [...blockers].sort();
}

export function listLiveProcessArgs(): LiveProcessArgs[] {
  return listLiveOpenProcessRuns().flatMap(({ run }) => {
    const snapshot = parseLaunchSnapshot(run.launchSnapshot);
    if (!snapshot) {
      return [];
    }
    return [{ instanceId: run.instanceId, cliArgs: snapshot.cliArgs }];
  });
}
