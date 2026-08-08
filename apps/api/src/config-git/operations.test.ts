import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { untrackMachineStateFiles } from "./machine-state.js";
import {
  checkoutConfigCommit,
  cloneConfigRepository,
  commitConfigChanges,
  createConfigBranch,
  initConfigRepository,
  resetConfigChanges,
  setConfigRemote,
  switchConfigBranch,
} from "./operations.js";
import {
  getConfigGitDiff,
  getConfigGitLog,
  getConfigGitStatus,
} from "./repository.js";

function git(args: string[]) {
  return execFileSync("git", args, {
    cwd: config.configDir,
    encoding: "utf8",
  }).trim();
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

beforeEach(() => {
  rmSync(config.configDir, { recursive: true, force: true });
  mkdirSync(resolve(config.configDir, "instances"), { recursive: true });
  mkdirSync(resolve(config.configDir, "proxy"), { recursive: true });
  writeJson(resolve(config.configDir, "settings.json"), {});
  writeJson(resolve(config.configDir, "argument-defaults.json"), {
    instance: [],
  });
  writeJson(resolve(config.configDir, "resources.json"), []);
  writeJson(resolve(config.configDir, "path-catalog.json"), []);
  writeJson(resolve(config.configDir, "envs.json"), []);
  writeJson(resolve(config.configDir, "nodes.json"), []);
  for (const name of [
    "targets",
    "models",
    "pipelines",
    "endpoints",
    "sources",
  ]) {
    writeJson(resolve(config.configDir, "proxy", `${name}.json`), []);
  }
  writeFileSync(
    resolve(config.configDir, ".gitignore"),
    ".secrets.json\n*.tmp\n",
    "utf8",
  );
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Config Test"]);
  git(["config", "user.email", "config@example.com"]);
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

test("untrackMachineStateFiles stages removal once and keeps worktree files", async () => {
  const untracked = await untrackMachineStateFiles();
  assert.deepEqual(untracked.sort(), ["envs.json", "path-catalog.json"]);

  const gitignore = readFileSync(
    resolve(config.configDir, ".gitignore"),
    "utf8",
  );
  assert.ok(gitignore.includes("path-catalog.json"));
  assert.ok(gitignore.includes("envs.json"));

  const status = git(["status", "--porcelain"]);
  assert.match(status, /D {2}envs\.json/);
  assert.match(status, /D {2}path-catalog\.json/);
  assert.ok(existsSync(resolve(config.configDir, "path-catalog.json")));

  assert.deepEqual(await untrackMachineStateFiles(), []);

  const committed = await commitConfigChanges({
    message: "untrack machine state",
    authorName: null,
    authorEmail: null,
  });
  assert.equal(committed.status.dirty, false);
  assert.equal(git(["ls-files", "--", "path-catalog.json", "envs.json"]), "");
  assert.ok(existsSync(resolve(config.configDir, "envs.json")));
});

test("tree operations preserve untracked machine-state files", async () => {
  const legacyHead = git(["rev-parse", "HEAD"]);
  await untrackMachineStateFiles();
  await commitConfigChanges({
    message: "untrack machine state",
    authorName: null,
    authorEmail: null,
  });

  const catalogPath = resolve(config.configDir, "path-catalog.json");
  writeJson(catalogPath, [
    {
      id: "0195a000-0000-7000-8000-000000000000",
      kind: "binary",
      name: "local llama-server",
      path: "/opt/llama/llama-server",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  const detached = await checkoutConfigCommit({ commit: legacyHead });
  assert.equal(detached.status.detached, true);
  assert.equal(JSON.parse(readFileSync(catalogPath, "utf8")).length, 0);

  const back = await switchConfigBranch({ branch: "main" });
  assert.equal(back.status.dirty, false);
  assert.ok(existsSync(catalogPath));
  assert.equal(git(["ls-files", "--", "path-catalog.json"]), "");
});

test("commitConfigChanges records portable changes and exposes them in log", async () => {
  writeFileSync(resolve(config.configDir, "README.md"), "hardware profile\n");
  const result = await commitConfigChanges({
    message: "add hardware profile",
    authorName: null,
    authorEmail: null,
  });
  assert.equal(result.status.dirty, false);
  const log = await getConfigGitLog(2);
  assert.equal(log[0]?.subject, "add hardware profile");
});

test("getConfigGitDiff shows untracked files as new-file diffs", async () => {
  writeJson(resolve(config.configDir, "proxy", "settings.json"), {
    allowAnonymous: true,
  });
  writeJson(resolve(config.configDir, "resources.json"), [{ id: "gpu0" }]);
  const full = await getConfigGitDiff();
  assert.match(
    full.unstaged,
    /diff --git a\/resources\.json b\/resources\.json/,
  );
  assert.match(
    full.unstaged,
    /diff --git a\/proxy\/settings\.json b\/proxy\/settings\.json/,
  );
  assert.match(full.unstaged, /new file mode/);
  assert.match(full.unstaged, /\+ {2}"allowAnonymous": true/);
  const single = await getConfigGitDiff("proxy/settings.json");
  assert.match(single.unstaged, /new file mode/);
  assert.doesNotMatch(single.unstaged, /resources\.json/);
  const tracked = await getConfigGitDiff("resources.json");
  assert.doesNotMatch(tracked.unstaged, /new file mode/);
  assert.match(tracked.unstaged, /"id": "gpu0"/);
});

test("getConfigGitStatus preserves an unstaged status and complete path", async () => {
  writeJson(resolve(config.configDir, "settings.json"), {
    modelScan: { directory: "/models", maxDepth: 2 },
  });

  const status = await getConfigGitStatus();

  assert.deepEqual(status.files, [
    { index: " ", worktree: "M", path: "settings.json" },
  ]);
});

test("createConfigBranch switches to a validated branch", async () => {
  const result = await createConfigBranch({
    branch: "gpu-a100",
    startPoint: null,
  });
  assert.equal(result.status.branch, "gpu-a100");
  assert.equal((await getConfigGitStatus()).branch, "gpu-a100");
});

test("resetConfigChanges optionally removes untracked files", async () => {
  const scratch = resolve(config.configDir, "scratch.json");
  writeFileSync(scratch, "{}\n");
  const result = await resetConfigChanges({
    includeUntracked: true,
    confirm: true,
  });
  assert.equal(result.status.dirty, false);
});

test("commitConfigChanges refuses tracked secret files", async () => {
  writeFileSync(resolve(config.configDir, ".env"), "TOKEN=secret\n");
  git(["add", "-f", ".env"]);
  await assert.rejects(
    commitConfigChanges({
      message: "unsafe",
      authorName: null,
      authorEmail: null,
    }),
    /sensitive path/,
  );
});

test("initConfigRepository tracks the current files without an origin", async () => {
  rmSync(resolve(config.configDir, ".git"), { recursive: true, force: true });
  const result = await initConfigRepository({
    branch: "local-main",
    message: "adopt current configuration",
    authorName: "Config Test",
    authorEmail: "config@example.com",
  });
  assert.equal(result.status.isGitRepo, true);
  assert.equal(result.status.hasCommits, true);
  assert.equal(result.status.branch, "local-main");
  assert.equal(result.status.originUrl, null);
  assert.equal(result.status.dirty, false);
  const log = await getConfigGitLog(2);
  assert.equal(log[0]?.subject, "adopt current configuration");
});

test("initConfigRepository refuses an existing repository", async () => {
  await assert.rejects(
    initConfigRepository({
      branch: "main",
      message: "again",
      authorName: null,
      authorEmail: null,
    }),
    /already a git repository/,
  );
});

test("setConfigRemote adds and removes origin", async () => {
  const added = await setConfigRemote({
    originUrl: "git@example.com:team/config.git",
    fetch: false,
  });
  assert.equal(added.status.originUrl, "git@example.com:team/config.git");
  const removed = await setConfigRemote({ originUrl: null, fetch: false });
  assert.equal(removed.status.originUrl, null);
});

test("setConfigRemote rejects credential-bearing origins", async () => {
  await assert.rejects(
    setConfigRemote({
      originUrl: "https://user:token@example.com/team/config.git",
      fetch: false,
    }),
    /credentials/,
  );
});

test("cloneConfigRepository refuses to discard unpushed work implicitly", async () => {
  await assert.rejects(
    cloneConfigRepository({
      originUrl: "git@example.com:team/config.git",
      branch: null,
      replaceExisting: true,
      discardUnpushed: false,
    }),
    /unpushed/,
  );
});

test("cloneConfigRepository requires replacement confirmation", async () => {
  await assert.rejects(
    cloneConfigRepository({
      originUrl: "git@example.com:team/config.git",
      branch: null,
      replaceExisting: false,
      discardUnpushed: true,
    }),
    /confirm replacement/,
  );
});

test("status does not adopt a parent repository", async () => {
  const nested = resolve(config.configDir, "nested");
  mkdirSync(nested);
  const original = config.configDir;
  config.configDir = nested;
  try {
    assert.equal((await getConfigGitStatus()).isGitRepo, false);
  } finally {
    config.configDir = original;
  }
});
