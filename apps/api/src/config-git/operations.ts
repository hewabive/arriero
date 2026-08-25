import {
  classifyConfigGitPath,
  configGitSensitivePathPattern,
  isActiveProcessStatus,
  isPlainRelativeConfigGitPath,
  isRestorableConfigGitPath,
  type ConfigGitCheckoutCommit,
  type ConfigGitClone,
  type ConfigGitCommitInput,
  type ConfigGitCreateBranch,
  type ConfigGitInit,
  type ConfigGitMutationResult,
  type ConfigGitRemote,
  type ConfigGitReset,
  type ConfigGitRestoreFiles,
  type ConfigGitSwitch,
  type ConfigGitValidation,
  type ConfigGitValidationIssue,
} from "@arriero/core";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { config } from "../config.js";
import { normalizeConfigFiles } from "../config-normalize.js";
import { getConfigDoctorReportOrNull } from "../doctor/report.js";
import { supervisor } from "../process/supervisor.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { ConfigBusyError, assertNoBlockingBackgroundWork } from "./busy.js";
import {
  CONFIG_GITIGNORE_CONTENT,
  TREE_CHANGE_PRESERVED_FILES,
  ensureLocalExclude,
  withMachineStatePreserved,
} from "./machine-state.js";
import {
  assertGitRemoteUrl,
  gitOutput,
  redactGitOutput,
  runGit,
  tryGit,
} from "./process.js";
import { reloadPortableConfigCaches } from "./reload.js";
import {
  assertConfigGitRepository,
  configBackupPath,
  getConfigGitStatus,
  parseFileStatuses,
  resolveConfigGitCommit,
} from "./repository.js";
import { resetProcessRequirement } from "./reset-guard.js";
import { withConfigGitOperation } from "./state.js";
import { validateConfigBlob, validateConfigRoot } from "./validation.js";

type MutationWork = {
  output: string;
  backupPath?: string | null;
  validation?: ConfigGitValidation;
};

function activeInstanceIds(): string[] {
  return supervisor
    .listStates()
    .filter((state) => isActiveProcessStatus(state.status))
    .map((state) => state.instanceId);
}

function assertConfigContentCanChange() {
  const activeInstances = activeInstanceIds();
  if (activeInstances.length > 0) {
    throw new ConfigBusyError(
      `stop managed processes before changing configuration: ${activeInstances.join(", ")}`,
    );
  }
  assertNoBlockingBackgroundWork("change");
}

async function assertClean() {
  const status = await tryGit(config.configDir, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) {
    throw new Error("configuration working tree has uncommitted changes");
  }
}

async function assertBranchName(branch: string) {
  if (branch.startsWith("-")) throw new Error("invalid branch name");
  await runGit(config.configDir, ["check-ref-format", "--branch", branch]);
}

async function assertNewBranchName(branch: string) {
  if (branch.startsWith("-")) throw new Error("invalid branch name");
  await runGit(config.configDir, ["check-ref-format", `refs/heads/${branch}`]);
}

const fallbackAuthorName = "arriero";
const fallbackAuthorEmail = "arriero@localhost";

async function commitIdentityArguments(input: {
  authorName: string | null;
  authorEmail: string | null;
}): Promise<string[]> {
  const name =
    input.authorName ??
    (await tryGit(config.configDir, ["config", "--get", "user.name"]));
  const email =
    input.authorEmail ??
    (await tryGit(config.configDir, ["config", "--get", "user.email"]));
  return [
    "-c",
    `user.name=${name ?? fallbackAuthorName}`,
    "-c",
    `user.email=${email ?? fallbackAuthorEmail}`,
  ];
}

async function stageAll(repository: string): Promise<string[]> {
  await runGit(repository, ["add", "-A", "--", "."]);
  const staged = await tryGit(repository, ["diff", "--cached", "--name-only"]);
  const paths = (staged?.split("\n") ?? []).filter(Boolean);
  const forbidden = paths.find((path) =>
    configGitSensitivePathPattern.test(path),
  );
  if (forbidden) {
    await runGit(repository, ["reset"]);
    throw new Error(`refusing to commit sensitive path: ${forbidden}`);
  }
  return paths;
}

function issuesSummary(issues: ConfigGitValidationIssue[]): string {
  return issues
    .slice(0, 8)
    .map((item) => `${item.path}: ${item.message}`)
    .join("; ");
}

function assertValid(validation: ConfigGitValidation) {
  if (validation.valid) return;
  throw new Error(
    `configuration validation failed: ${issuesSummary(validation.issues)}`,
  );
}

async function assertNoSensitiveTrackedFiles(repository: string) {
  const tracked = await tryGit(repository, ["ls-files"]);
  const forbidden = (tracked?.split("\n") ?? []).find((path) =>
    configGitSensitivePathPattern.test(path),
  );
  if (forbidden) {
    throw new Error(`repository tracks sensitive path: ${forbidden}`);
  }
}

async function validateCommit(commit: string): Promise<ConfigGitValidation> {
  const parent = mkdtempSync(
    resolve(dirname(config.configDir), ".config-git-validate-"),
  );
  const worktree = resolve(parent, "worktree");
  try {
    await runGit(config.configDir, [
      "worktree",
      "add",
      "--detach",
      worktree,
      commit,
    ]);
    await assertNoSensitiveTrackedFiles(worktree);
    return validateConfigRoot(worktree);
  } finally {
    if (existsSync(worktree)) {
      await runGit(config.configDir, [
        "worktree",
        "remove",
        "--force",
        worktree,
      ]).catch(() => undefined);
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

async function assertPreparedRepository() {
  await assertConfigGitRepository();
  await ensureLocalExclude(config.configDir);
}

async function mutation(
  operation: string,
  work: () => Promise<MutationWork>,
): Promise<ConfigGitMutationResult> {
  const result = await withConfigGitOperation(operation, work);
  const validation = result.validation ?? validateConfigRoot(config.configDir);
  const [doctor, status] = await Promise.all([
    getConfigDoctorReportOrNull({ operation }),
    getConfigGitStatus(),
  ]);
  return {
    operation,
    output: result.output,
    backupPath: result.backupPath ?? null,
    status,
    validation,
    doctor,
  };
}

export function initConfigRepository(
  input: ConfigGitInit,
): Promise<ConfigGitMutationResult> {
  return mutation("init", async () => {
    if (!existsSync(config.configDir)) {
      throw new Error(
        `configuration directory does not exist: ${config.configDir}`,
      );
    }
    const existing = await getConfigGitStatus();
    if (existing.isGitRepo) {
      throw new Error("configuration directory is already a git repository");
    }
    await assertNewBranchName(input.branch);
    const validation = validateConfigRoot(config.configDir);
    assertValid(validation);
    if (!existsSync(config.configGitignoreFile)) {
      writeFileSync(
        config.configGitignoreFile,
        CONFIG_GITIGNORE_CONTENT,
        "utf8",
      );
    }

    const initialized = await runGit(config.configDir, [
      "init",
      "-b",
      input.branch,
    ]);
    try {
      await ensureLocalExclude(config.configDir);
      if (input.authorName) {
        await runGit(config.configDir, [
          "config",
          "user.name",
          input.authorName,
        ]);
      }
      if (input.authorEmail) {
        await runGit(config.configDir, [
          "config",
          "user.email",
          input.authorEmail,
        ]);
      }
      await stageAll(config.configDir);
      const args = await commitIdentityArguments(input);
      args.push("commit", "-m", input.message);
      const committed = await runGit(config.configDir, args, {
        timeoutMs: 60_000,
      });
      return {
        output: [gitOutput(initialized), gitOutput(committed)]
          .filter(Boolean)
          .join("\n"),
        validation,
      };
    } catch (error) {
      rmSync(resolve(config.configDir, ".git"), {
        recursive: true,
        force: true,
      });
      throw error;
    }
  });
}

export function setConfigRemote(
  input: ConfigGitRemote,
): Promise<ConfigGitMutationResult> {
  return mutation("remote", async () => {
    await assertPreparedRepository();
    const existing = await tryGit(config.configDir, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (input.originUrl === null) {
      if (!existing) throw new Error("origin remote is not configured");
      await runGit(config.configDir, ["remote", "remove", "origin"]);
      return { output: "Removed origin." };
    }
    assertGitRemoteUrl(input.originUrl);
    if (existing) {
      await runGit(config.configDir, ["remote", "remove", "origin"]);
    }
    await runGit(config.configDir, [
      "remote",
      "add",
      "origin",
      input.originUrl,
    ]);
    const lines = [redactGitOutput(`Set origin to ${input.originUrl}.`)];
    if (input.fetch) {
      try {
        const fetched = await runGit(
          config.configDir,
          ["fetch", "origin", "--prune"],
          { timeoutMs: 120_000 },
        );
        lines.push(gitOutput(fetched) || "Fetched origin.");
      } catch (error) {
        lines.push(`fetch failed: ${(error as Error).message}`);
      }
    }
    return { output: lines.join("\n") };
  });
}

export function cloneConfigRepository(
  input: ConfigGitClone,
): Promise<ConfigGitMutationResult> {
  return mutation("clone", async () => {
    assertConfigContentCanChange();
    assertGitRemoteUrl(input.originUrl);
    const existing = await getConfigGitStatus();
    if (!input.replaceExisting) {
      throw new Error(
        "clone replaces the current configuration; confirm replacement first",
      );
    }
    if (
      (existing.dirty || existing.hasUnpushedCommits) &&
      !input.discardUnpushed
    ) {
      throw new Error(
        "current configuration has uncommitted or unpushed changes; confirm discarding them first",
      );
    }

    const parent = dirname(config.configDir);
    const temporary = mkdtempSync(resolve(parent, ".config-git-clone-"));
    const staging = resolve(temporary, "repository");
    const args = ["clone", "--origin", "origin"];
    if (input.branch) args.push("--branch", input.branch);
    args.push("--", input.originUrl, staging);
    let backupPath: string | null = null;
    try {
      const cloned = await runGit(parent, args, { timeoutMs: 120_000 });
      await assertNoSensitiveTrackedFiles(staging);
      const validation = validateConfigRoot(staging);
      assertValid(validation);
      if (existsSync(config.secretsFile)) {
        copyFileSync(config.secretsFile, resolve(staging, ".secrets.json"));
      }
      for (const name of TREE_CHANGE_PRESERVED_FILES) {
        const source = resolve(config.configDir, name);
        const destination = resolve(staging, name);
        if (existsSync(source) && !existsSync(destination)) {
          copyFileSync(source, destination);
        }
      }
      await ensureLocalExclude(staging);
      backupPath = configBackupPath(Date.now());
      if (existsSync(config.configDir))
        renameSync(config.configDir, backupPath);
      try {
        renameSync(staging, config.configDir);
      } catch (error) {
        if (backupPath && existsSync(backupPath)) {
          renameSync(backupPath, config.configDir);
        }
        throw error;
      }
      reloadPortableConfigCaches();
      return { output: gitOutput(cloned), backupPath, validation };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

export function fetchConfigRepository(): Promise<ConfigGitMutationResult> {
  return mutation("fetch", async () => {
    await assertPreparedRepository();
    const result = await runGit(
      config.configDir,
      ["fetch", "origin", "--prune"],
      {
        timeoutMs: 120_000,
      },
    );
    return { output: gitOutput(result) || "Fetched origin." };
  });
}

export function pullConfigRepository(): Promise<ConfigGitMutationResult> {
  return mutation("pull", async () => {
    assertConfigContentCanChange();
    await assertPreparedRepository();
    await assertClean();
    const branch = await tryGit(config.configDir, ["branch", "--show-current"]);
    if (!branch) throw new Error("cannot pull while HEAD is detached");
    const fetched = await runGit(
      config.configDir,
      ["fetch", "origin", "--prune"],
      {
        timeoutMs: 120_000,
      },
    );
    const upstream = await tryGit(config.configDir, [
      "rev-parse",
      "--abbrev-ref",
      "@{u}",
    ]);
    if (!upstream) throw new Error(`branch "${branch}" has no upstream`);
    const ancestor = await runGit(
      config.configDir,
      ["merge-base", "--is-ancestor", "HEAD", upstream],
      { allowExitCodes: [0, 1] },
    );
    if (ancestor.exitCode !== 0) {
      throw new Error(
        "local and upstream branches have diverged; merge manually",
      );
    }
    const upstreamCommit = await resolveConfigGitCommit(upstream);
    const validation = await validateCommit(upstreamCommit);
    assertValid(validation);
    const merged = await withMachineStatePreserved(config.configDir, () =>
      runGit(config.configDir, ["merge", "--ff-only", upstream]),
    );
    reloadPortableConfigCaches();
    return {
      output: [gitOutput(fetched), gitOutput(merged)]
        .filter(Boolean)
        .join("\n"),
      validation,
    };
  });
}

export function switchConfigBranch(
  input: ConfigGitSwitch,
): Promise<ConfigGitMutationResult> {
  return mutation("switch", async () => {
    assertConfigContentCanChange();
    await assertPreparedRepository();
    await assertClean();
    await assertBranchName(input.branch);
    const local = await tryGit(config.configDir, [
      "show-ref",
      "--verify",
      `refs/heads/${input.branch}`,
    ]);
    const remote = await tryGit(config.configDir, [
      "show-ref",
      "--verify",
      `refs/remotes/origin/${input.branch}`,
    ]);
    if (!local && !remote) throw new Error(`unknown branch: ${input.branch}`);
    const commit = await resolveConfigGitCommit(
      local ? input.branch : `origin/${input.branch}`,
    );
    const validation = await validateCommit(commit);
    assertValid(validation);
    const result = await withMachineStatePreserved(config.configDir, () =>
      local
        ? runGit(config.configDir, ["switch", input.branch])
        : runGit(config.configDir, [
            "switch",
            "--track",
            "-c",
            input.branch,
            `origin/${input.branch}`,
          ]),
    );
    reloadPortableConfigCaches();
    return { output: gitOutput(result), validation };
  });
}

export function createConfigBranch(
  input: ConfigGitCreateBranch,
): Promise<ConfigGitMutationResult> {
  return mutation("create-branch", async () => {
    assertConfigContentCanChange();
    await assertPreparedRepository();
    await assertClean();
    await assertBranchName(input.branch);
    const startPoint = input.startPoint ?? "HEAD";
    const commit = await resolveConfigGitCommit(startPoint);
    const validation = await validateCommit(commit);
    assertValid(validation);
    const result = await withMachineStatePreserved(config.configDir, () =>
      runGit(config.configDir, ["switch", "-c", input.branch, commit]),
    );
    reloadPortableConfigCaches();
    return { output: gitOutput(result), validation };
  });
}

export function checkoutConfigCommit(
  input: ConfigGitCheckoutCommit,
): Promise<ConfigGitMutationResult> {
  return mutation("checkout-commit", async () => {
    assertConfigContentCanChange();
    await assertPreparedRepository();
    await assertClean();
    const hash = await resolveConfigGitCommit(input.commit);
    const validation = await validateCommit(hash);
    assertValid(validation);
    const result = await withMachineStatePreserved(config.configDir, () =>
      runGit(config.configDir, ["switch", "--detach", hash]),
    );
    reloadPortableConfigCaches();
    return { output: gitOutput(result), validation };
  });
}

export function resetConfigChanges(
  input: ConfigGitReset,
): Promise<ConfigGitMutationResult> {
  return mutation("reset", async () => {
    await assertPreparedRepository();
    const statusResult = await runGit(config.configDir, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const requirement = resetProcessRequirement(
      parseFileStatuses(statusResult.stdout),
      input.includeUntracked,
      activeInstanceIds(),
    );
    if (requirement.scope === "all-processes") {
      assertConfigContentCanChange();
    } else if (requirement.scope === "deleted-instances") {
      throw new ConfigBusyError(
        `stop managed processes whose configuration files would be deleted: ${requirement.instanceIds.join(", ")}`,
      );
    } else {
      assertNoBlockingBackgroundWork("change");
    }
    const validation = await validateCommit("HEAD");
    assertValid(validation);
    const reset = await runGit(config.configDir, ["reset", "--hard", "HEAD"]);
    let cleanOutput = "";
    if (input.includeUntracked) {
      cleanOutput = gitOutput(await runGit(config.configDir, ["clean", "-fd"]));
    }
    const currentValidation = validateConfigRoot(config.configDir);
    assertValid(currentValidation);
    reloadPortableConfigCaches();
    return {
      output: [gitOutput(reset), cleanOutput].filter(Boolean).join("\n"),
      validation: currentValidation,
    };
  });
}

const MAX_RESTORE_BLOB_BYTES = 1024 * 1024;

async function loadRestoreBlob(
  hash: string,
  ref: string,
  path: string,
): Promise<{
  path: string;
  issues: ConfigGitValidationIssue[];
  content: string | null;
}> {
  const objectName = `${hash}:${path}`;
  const type = await tryGit(config.configDir, ["cat-file", "-t", objectName]);
  if (type !== "blob") {
    const message =
      type === "tree" ? `is a directory at ${ref}` : `does not exist at ${ref}`;
    return { path, issues: [{ path, message }], content: null };
  }
  const size = Number(
    (await tryGit(config.configDir, ["cat-file", "-s", objectName])) ?? 0,
  );
  if (size > MAX_RESTORE_BLOB_BYTES) {
    const message = `file at ${ref} exceeds ${MAX_RESTORE_BLOB_BYTES} bytes`;
    return { path, issues: [{ path, message }], content: null };
  }
  const content = (
    await runGit(config.configDir, ["cat-file", "blob", objectName])
  ).stdout;
  return { path, issues: validateConfigBlob(path, content), content };
}

export function restoreConfigFiles(
  input: ConfigGitRestoreFiles,
): Promise<ConfigGitMutationResult> {
  return mutation("restore-files", async () => {
    await assertPreparedRepository();
    const paths = [...new Set(input.paths)];
    const pathIssues: ConfigGitValidationIssue[] = [];
    for (const path of paths) {
      if (!isPlainRelativeConfigGitPath(path)) {
        pathIssues.push({ path, message: "invalid configuration path" });
      } else if (!isRestorableConfigGitPath(path)) {
        pathIssues.push({
          path,
          message: "not a restorable configuration file",
        });
      }
    }
    if (pathIssues.length > 0) {
      throw new Error(issuesSummary(pathIssues));
    }
    if (paths.some((path) => classifyConfigGitPath(path) === "settings")) {
      assertConfigContentCanChange();
    }
    const hash = await resolveConfigGitCommit(input.ref);

    const blobResults = await Promise.all(
      paths.map((path) => loadRestoreBlob(hash, input.ref, path)),
    );
    const blobIssues = blobResults.flatMap((result) => result.issues);
    if (blobIssues.length > 0) {
      throw new Error(
        `restore validation failed: ${issuesSummary(blobIssues)}`,
      );
    }
    const blobs = new Map<string, string>();
    for (const result of blobResults) {
      if (result.content !== null) {
        blobs.set(result.path, result.content);
      }
    }

    const written: string[] = [];
    const unchanged: string[] = [];
    const snapshots = new Map<string, string | null>();
    for (const [path, content] of blobs) {
      const absolute = resolve(config.configDir, path);
      if (existsSync(absolute)) {
        if (lstatSync(absolute).isSymbolicLink()) {
          throw new Error(`refusing to overwrite a symlinked path: ${path}`);
        }
        const current = readFileSync(absolute, "utf8");
        if (current === content) {
          unchanged.push(path);
          continue;
        }
        snapshots.set(path, current);
      } else {
        snapshots.set(path, null);
      }
      atomicWriteFile(absolute, content);
      written.push(path);
    }

    if (written.length === 0) {
      return {
        output: `Already up to date with ${hash.slice(0, 7)}.`,
        validation: validateConfigRoot(config.configDir),
      };
    }

    const validation = validateConfigRoot(config.configDir);
    if (!validation.valid) {
      const failure = `restore would leave the configuration invalid: ${issuesSummary(validation.issues)}`;
      try {
        for (const [path, previous] of snapshots) {
          const absolute = resolve(config.configDir, path);
          if (previous === null) {
            rmSync(absolute, { force: true });
          } else {
            atomicWriteFile(absolute, previous);
          }
        }
      } catch (rollbackError) {
        throw new Error(
          `${failure}; rollback failed: ${(rollbackError as Error).message}`,
        );
      }
      throw new Error(failure);
    }

    reloadPortableConfigCaches();
    const normalized = normalizeConfigFiles();
    const lines = [
      `Restored ${written.length} file(s) from ${hash.slice(0, 7)}:`,
      ...written.map((path) => `  ${path}`),
    ];
    if (unchanged.length > 0) {
      lines.push(`Already up to date: ${unchanged.join(", ")}`);
    }
    if (normalized.length > 0) {
      lines.push(`Normalized after restore: ${normalized.join(", ")}`);
    }
    return { output: lines.join("\n"), validation };
  });
}

async function stageSelectedPaths(
  repository: string,
  requestedPaths: string[],
): Promise<string[]> {
  const requested = [...new Set(requestedPaths)];
  const statusResult = await runGit(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const changeByPath = new Map(
    parseFileStatuses(statusResult.stdout).map((file) => [file.path, file]),
  );
  const unchanged = requested.filter((path) => !changeByPath.has(path));
  if (unchanged.length > 0) {
    throw new Error(
      `no configuration changes to commit for: ${unchanged.join(", ")}`,
    );
  }
  const pathspecs = new Set<string>();
  for (const path of requested) {
    pathspecs.add(path);
    const origPath = changeByPath.get(path)?.origPath;
    if (origPath) pathspecs.add(origPath);
  }
  const forbidden = [...pathspecs].find((path) =>
    configGitSensitivePathPattern.test(path),
  );
  if (forbidden) {
    throw new Error(`refusing to commit sensitive path: ${forbidden}`);
  }
  await runGit(repository, ["reset", "--quiet"]);
  await runGit(repository, [
    "add",
    "-A",
    "--",
    ...[...pathspecs].map((path) => `:(literal)${path}`),
  ]);
  const staged = await tryGit(repository, ["diff", "--cached", "--name-only"]);
  return (staged?.split("\n") ?? []).filter(Boolean);
}

async function validateStagedTree(input: {
  authorName: string | null;
  authorEmail: string | null;
}): Promise<ConfigGitValidation> {
  const tree = (await runGit(config.configDir, ["write-tree"])).stdout.trim();
  const head = await tryGit(config.configDir, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const args = await commitIdentityArguments(input);
  args.push("commit-tree", tree, "-m", "arriero commit candidate");
  if (head) args.push("-p", head);
  const candidate = (await runGit(config.configDir, args)).stdout.trim();
  return validateCommit(candidate);
}

export function commitConfigChanges(
  input: ConfigGitCommitInput,
): Promise<ConfigGitMutationResult> {
  return mutation("commit", async () => {
    await assertPreparedRepository();
    await assertNoSensitiveTrackedFiles(config.configDir);
    let validation: ConfigGitValidation;
    let staged: string[];
    if (input.paths === null) {
      validation = validateConfigRoot(config.configDir);
      assertValid(validation);
      staged = await stageAll(config.configDir);
      if (staged.length === 0) {
        throw new Error("there are no configuration changes to commit");
      }
    } else {
      staged = await stageSelectedPaths(config.configDir, input.paths);
      if (staged.length === 0) {
        throw new Error("there are no configuration changes to commit");
      }
      validation = await validateStagedTree(input);
      if (!validation.valid) {
        await runGit(config.configDir, ["reset", "--quiet"]);
      }
      assertValid(validation);
    }
    const args = await commitIdentityArguments(input);
    args.push("commit", "-m", input.message);
    const result = await runGit(config.configDir, args, { timeoutMs: 60_000 });
    return { output: gitOutput(result), validation };
  });
}

export function pushConfigRepository(): Promise<ConfigGitMutationResult> {
  return mutation("push", async () => {
    await assertPreparedRepository();
    const branch = await tryGit(config.configDir, ["branch", "--show-current"]);
    if (!branch) throw new Error("create or switch to a branch before pushing");
    const origin = await tryGit(config.configDir, [
      "remote",
      "get-url",
      "origin",
    ]);
    if (!origin) throw new Error("origin remote is not configured");
    const upstream = await tryGit(config.configDir, [
      "rev-parse",
      "--abbrev-ref",
      "@{u}",
    ]);
    const args = upstream
      ? ["push", "origin", branch]
      : ["push", "--set-upstream", "origin", branch];
    const result = await runGit(config.configDir, args, { timeoutMs: 120_000 });
    return { output: gitOutput(result) || `Pushed ${branch}.` };
  });
}
