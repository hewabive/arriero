import type {
  ConfigDoctorReport,
  ConfigGitBackups,
  ConfigGitCheckoutCommit,
  ConfigGitClone,
  ConfigGitCommit,
  ConfigGitCommitDetail,
  ConfigGitCommitInput,
  ConfigGitCreateBranch,
  ConfigGitDiff,
  ConfigGitDirtySummary,
  ConfigGitInit,
  ConfigGitMutationResult,
  ConfigGitRemote,
  ConfigGitReset,
  ConfigGitRestoreFiles,
  ConfigGitStatus,
  ConfigGitSwitch,
  ConfigGitValidation,
} from "@arriero/core";

import { buildQuery, request } from "./http.js";

export function getConfigGitStatus() {
  return request<{ data: ConfigGitStatus }>("/api/config-git/status");
}

export function getConfigGitDirty() {
  return request<{ data: ConfigGitDirtySummary }>("/api/config-git/dirty");
}

export function getConfigGitValidation() {
  return request<{ data: ConfigGitValidation }>("/api/config-git/validation");
}

export function getConfigDoctorReport() {
  return request<{ data: ConfigDoctorReport }>("/api/config-git/doctor");
}

export function getConfigGitDiff(path?: string) {
  return request<{ data: ConfigGitDiff }>(
    `/api/config-git/diff${buildQuery(path ? { path } : {})}`,
  );
}

export function getConfigGitLog(limit = 50) {
  return request<{ data: ConfigGitCommit[] }>(
    `/api/config-git/log${buildQuery({ limit: String(limit) })}`,
  );
}

export function getConfigGitCommit(hash: string) {
  return request<{ data: ConfigGitCommitDetail }>(
    `/api/config-git/commits/${encodeURIComponent(hash)}`,
  );
}

function mutate(
  path: string,
  body?: unknown,
): Promise<{ data: ConfigGitMutationResult }> {
  return request<{ data: ConfigGitMutationResult }>(path, {
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

export function restoreConfigFiles(input: ConfigGitRestoreFiles) {
  return mutate("/api/config-git/restore-files", input);
}

export function commitConfigChanges(input: ConfigGitCommitInput) {
  return mutate("/api/config-git/commit", input);
}

export function deleteConfigBackup(name: string) {
  return request<{ data: ConfigGitBackups }>(
    `/api/config-git/backups/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}
