import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import {
  commitConfigChanges,
  createConfigBranch,
  resetConfigChanges,
} from "./operations.js";
import { getConfigGitLog, getConfigGitStatus } from "./repository.js";

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
