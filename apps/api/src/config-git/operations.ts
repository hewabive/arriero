import type {
  ConfigGitCheckoutCommit,
  ConfigGitClone,
  ConfigGitCommitInput,
  ConfigGitCreateBranch,
  ConfigGitInit,
  ConfigGitMutationResult,
  ConfigGitRemote,
  ConfigGitReset,
  ConfigGitSwitch,
  ConfigGitValidation,
} from "@arriero/core";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { buildRunner } from "../build/runner.js";
import { config } from "../config.js";
import { environmentRunner } from "../envs/runner.js";
import { supervisor } from "../process/supervisor.js";
import { anySourceRepositoryOperationActive } from "../sources/state.js";
import {
  assertGitRemoteUrl,
  gitOutput,
  redactGitOutput,
  runGit,
  tryGit,
} from "./process.js";
import { reloadPortableConfigCaches } from "./reload.js";
import { assertConfigGitRepository, getConfigGitStatus } from "./repository.js";
import { withConfigGitOperation } from "./state.js";
import { validateConfigRoot } from "./validation.js";

type MutationWork = {
  output: string;
  backupPath?: string | null;
  validation?: ConfigGitValidation;
};

const activeStatuses = new Set(["starting", "running", "stopping"]);
const forbiddenTrackedPath =
  /(^|\/)(\.secrets\.json|\.env(?:\..*)?|.*\.(?:pem|key))$/i;

function assertConfigContentCanChange() {
  const activeInstances = supervisor
    .listStates()
    .filter((state) => activeStatuses.has(state.status));
  if (activeInstances.length > 0) {
    throw new Error(
      `stop managed processes before changing configuration: ${activeInstances.map((item) => item.instanceId).join(", ")}`,
    );
  }
  if (buildRunner.isRunning()) {
    throw new Error("cannot change configuration while a build is running");
  }
  if (environmentRunner.activeEnvironmentId()) {
    throw new Error(
      "cannot change configuration while an environment install is running",
    );
  }
  if (anySourceRepositoryOperationActive()) {
    throw new Error(
      "cannot change configuration while a source repository operation is running",
    );
  }
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
  const forbidden = paths.find((path) => forbiddenTrackedPath.test(path));
  if (forbidden) {
    await runGit(repository, ["reset"]);
    throw new Error(`refusing to commit sensitive path: ${forbidden}`);
  }
  return paths;
}

function assertValid(validation: ConfigGitValidation) {
  if (validation.valid) return;
  const summary = validation.issues
    .slice(0, 8)
    .map((item) => `${item.path}: ${item.message}`)
    .join("; ");
  throw new Error(`configuration validation failed: ${summary}`);
}

async function assertNoSensitiveTrackedFiles(repository: string) {
  const tracked = await tryGit(repository, ["ls-files"]);
  const forbidden = (tracked?.split("\n") ?? []).find((path) =>
    forbiddenTrackedPath.test(path),
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

async function ensureLocalExclude(repository: string) {
  const gitPath = await tryGit(repository, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  if (!gitPath) return;
  const path = isAbsolute(gitPath) ? gitPath : resolve(repository, gitPath);
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = [".secrets.json", "*.tmp"].filter(
    (entry) => !current.split(/\r?\n/).includes(entry),
  );
  if (missing.length > 0) {
    appendFileSync(
      path,
      `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
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
  return {
    operation,
    output: result.output,
    backupPath: result.backupPath ?? null,
    status: await getConfigGitStatus(),
    validation,
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
        ".secrets.json\n*.tmp\n",
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
      await ensureLocalExclude(staging);
      backupPath = `${config.configDir}.backup-${Date.now()}`;
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
    const upstreamCommit = await runGit(config.configDir, [
      "rev-parse",
      "--verify",
      `${upstream}^{commit}`,
    ]);
    const validation = await validateCommit(upstreamCommit.stdout.trim());
    assertValid(validation);
    const merged = await runGit(config.configDir, [
      "merge",
      "--ff-only",
      upstream,
    ]);
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
    const commit = await runGit(config.configDir, [
      "rev-parse",
      "--verify",
      `${local ? input.branch : `origin/${input.branch}`}^{commit}`,
    ]);
    const validation = await validateCommit(commit.stdout.trim());
    assertValid(validation);
    const result = local
      ? await runGit(config.configDir, ["switch", input.branch])
      : await runGit(config.configDir, [
          "switch",
          "--track",
          "-c",
          input.branch,
          `origin/${input.branch}`,
        ]);
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
    const commit = await runGit(config.configDir, [
      "rev-parse",
      "--verify",
      `${startPoint}^{commit}`,
    ]);
    const validation = await validateCommit(commit.stdout.trim());
    assertValid(validation);
    const result = await runGit(config.configDir, [
      "switch",
      "-c",
      input.branch,
      commit.stdout.trim(),
    ]);
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
    const commit = await runGit(config.configDir, [
      "rev-parse",
      "--verify",
      `${input.commit}^{commit}`,
    ]);
    const hash = commit.stdout.trim();
    const validation = await validateCommit(hash);
    assertValid(validation);
    const result = await runGit(config.configDir, ["switch", "--detach", hash]);
    reloadPortableConfigCaches();
    return { output: gitOutput(result), validation };
  });
}

export function resetConfigChanges(
  input: ConfigGitReset,
): Promise<ConfigGitMutationResult> {
  return mutation("reset", async () => {
    assertConfigContentCanChange();
    await assertPreparedRepository();
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

export function commitConfigChanges(
  input: ConfigGitCommitInput,
): Promise<ConfigGitMutationResult> {
  return mutation("commit", async () => {
    await assertPreparedRepository();
    const validation = validateConfigRoot(config.configDir);
    assertValid(validation);
    await assertNoSensitiveTrackedFiles(config.configDir);
    const staged = await stageAll(config.configDir);
    if (staged.length === 0)
      throw new Error("there are no configuration changes to commit");
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
