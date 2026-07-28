import type {
  ConfigGitCheckoutCommit,
  ConfigGitClone,
  ConfigGitCommit,
  ConfigGitCommitInput,
  ConfigGitCreateBranch,
  ConfigGitDiff,
  ConfigGitInit,
  ConfigGitMutationResult,
  ConfigGitRemote,
  ConfigGitReset,
  ConfigGitStatus,
  ConfigGitSwitch,
  ConfigGitValidation,
} from "@arriero/core";

import { buildQuery, nodeRequest } from "./http.js";

export function getConfigGitStatus() {
  return nodeRequest<{ data: ConfigGitStatus }>("/api/config-git/status");
}

export function getConfigGitValidation() {
  return nodeRequest<{ data: ConfigGitValidation }>(
    "/api/config-git/validation",
  );
}

export function getConfigGitDiff() {
  return nodeRequest<{ data: ConfigGitDiff }>("/api/config-git/diff");
}

export function getConfigGitLog(limit = 50) {
  return nodeRequest<{ data: ConfigGitCommit[] }>(
    `/api/config-git/log${buildQuery({ limit: String(limit) })}`,
  );
}

function mutate(
  path: string,
  body?: unknown,
): Promise<{ data: ConfigGitMutationResult }> {
  return nodeRequest<{ data: ConfigGitMutationResult }>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function initConfigRepository(input: ConfigGitInit) {
  return mutate("/api/config-git/init", input);
}

export function setConfigRemote(input: ConfigGitRemote) {
  return mutate("/api/config-git/remote", input);
}

export function cloneConfigRepository(input: ConfigGitClone) {
  return mutate("/api/config-git/clone", input);
}

export function fetchConfigRepository() {
  return mutate("/api/config-git/fetch");
}

export function pullConfigRepository() {
  return mutate("/api/config-git/pull");
}

export function pushConfigRepository() {
  return mutate("/api/config-git/push");
}

export function switchConfigBranch(input: ConfigGitSwitch) {
  return mutate("/api/config-git/switch", input);
}

export function createConfigBranch(input: ConfigGitCreateBranch) {
  return mutate("/api/config-git/branches", input);
}

export function checkoutConfigCommit(input: ConfigGitCheckoutCommit) {
  return mutate("/api/config-git/checkout", input);
}

export function resetConfigChanges(input: ConfigGitReset) {
  return mutate("/api/config-git/reset", input);
}

export function commitConfigChanges(input: ConfigGitCommitInput) {
  return mutate("/api/config-git/commit", input);
}
