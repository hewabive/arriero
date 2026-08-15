import {
  engineDescriptor,
  type Instance,
  type InstanceArgs,
} from "@arriero/core";

import { instanceBaseUrl, rpcWorkerEndpoint } from "../instances/endpoint.js";
import { parseLaunchSnapshot, type LaunchSnapshot } from "./launch-snapshot.js";
import { latestProcessRun } from "./runs-repository.js";

type RuntimeEndpointRun = {
  status: string;
  launchSnapshot: string | null;
};

type RuntimeEndpointInstance = Pick<Instance, "name" | "kind" | "args">;

const activeEndpointStatuses = new Set([
  "starting",
  "running",
  "stopping",
  "stale",
]);

function snapshotArg(
  cliArgs: readonly string[],
  keys: readonly string[],
): string | undefined {
  const keySet = new Set(keys);
  let value: string | undefined;
  for (let index = 0; index < cliArgs.length; index += 1) {
    if (keySet.has(cliArgs[index] ?? "")) {
      value = cliArgs[index + 1];
    }
  }
  return value;
}

function replaceArgGroup(
  args: InstanceArgs,
  cliArgs: readonly string[],
  keys: readonly string[],
) {
  if (keys.length === 0) {
    return;
  }
  for (const key of keys) {
    delete args[key];
  }
  const value = snapshotArg(cliArgs, keys);
  const canonicalKey = keys[0];
  if (value !== undefined && canonicalKey) {
    args[canonicalKey] = value;
  }
}

function instanceWithLaunchEndpoint<T extends RuntimeEndpointInstance>(
  instance: T,
  snapshot: LaunchSnapshot,
): T {
  const http = engineDescriptor(instance.kind).http;
  const args = { ...instance.args };
  replaceArgGroup(args, snapshot.cliArgs, http.hostArgKeys);
  replaceArgGroup(args, snapshot.cliArgs, http.portArgKeys);
  replaceArgGroup(args, snapshot.cliArgs, http.apiPrefixArgKeys);
  return { ...instance, args };
}

export function runtimeEndpointInstance<T extends RuntimeEndpointInstance>(
  instance: T,
  run: RuntimeEndpointRun | null = latestProcessRun(instance.name),
): T {
  const snapshot = activeLaunchSnapshot(instance.name, run);
  return snapshot ? instanceWithLaunchEndpoint(instance, snapshot) : instance;
}

export function activeLaunchSnapshot(
  instanceName: string,
  run: RuntimeEndpointRun | null = latestProcessRun(instanceName),
): LaunchSnapshot | null {
  if (!run || !activeEndpointStatuses.has(run.status)) {
    return null;
  }
  return parseLaunchSnapshot(run.launchSnapshot);
}

export function runtimeInstanceBaseUrl(
  instance: RuntimeEndpointInstance,
  run?: RuntimeEndpointRun | null,
): string {
  return instanceBaseUrl(
    run === undefined
      ? runtimeEndpointInstance(instance)
      : runtimeEndpointInstance(instance, run),
  );
}

export function runtimeRpcWorkerEndpoint(
  instance: RuntimeEndpointInstance,
  run?: RuntimeEndpointRun | null,
): { host: string; port: number } | null {
  return rpcWorkerEndpoint(
    run === undefined
      ? runtimeEndpointInstance(instance)
      : runtimeEndpointInstance(instance, run),
  );
}
