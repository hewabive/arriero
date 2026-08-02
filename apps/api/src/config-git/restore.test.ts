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
import { resetInstancesCache } from "../instances/config-files.js";
import { resetResourcePoolsCache } from "../resources/repository.js";
import { restoreConfigFiles } from "./operations.js";
import { getConfigGitCommit, getConfigGitDiff } from "./repository.js";

function git(args: string[]) {
  return execFileSync("git", args, {
    cwd: config.configDir,
    encoding: "utf8",
  }).trim();
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commitAll(message: string) {
  git(["add", "-A", "."]);
  git(["commit", "-m", message]);
}

function instanceRecord(name: string, memory: unknown[] = []) {
  return {
    name,
    kind: "llama-server",
    binaryPath: "/opt/llama/llama-server",
    args: { "--port": 5190 },
    env: {},
    memory,
    rpcWorkers: [],
  };
}

beforeEach(() => {
  rmSync(config.configDir, { recursive: true, force: true });
  mkdirSync(resolve(config.configDir, "instances"), { recursive: true });
  mkdirSync(resolve(config.configDir, "presets"), { recursive: true });
  mkdirSync(resolve(config.configDir, "proxy"), { recursive: true });
  writeJson(resolve(config.configDir, "settings.json"), {});
  writeJson(resolve(config.configDir, "resources.json"), []);
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
    ".secrets.json\n*.tmp\npath-catalog.json\nenvs.json\n",
    "utf8",
  );
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Restore Test"]);
  git(["config", "user.email", "restore@example.com"]);
  commitAll("initial");
  resetInstancesCache();
  resetResourcePoolsCache();
});

test("restore lands byte-identical content as an unstaged change", async () => {
  const settingsPath = resolve(config.configDir, "settings.json");
  const original = readFileSync(settingsPath, "utf8");
  writeJson(settingsPath, { modelScan: { directory: "/models", maxDepth: 2 } });
  commitAll("change settings");

  const result = await restoreConfigFiles({
    ref: "HEAD~1",
    paths: ["settings.json"],
  });

  assert.match(result.output, /Restored 1 file/);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  assert.equal(result.status.dirty, true);
  assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "main"]));
  assert.equal(git(["diff", "--cached", "--name-only"]), "");
  assert.equal(git(["diff", "--name-only"]), "settings.json");
});

test("discard via ref HEAD reverts an uncommitted edit", async () => {
  const settingsPath = resolve(config.configDir, "settings.json");
  const committed = readFileSync(settingsPath, "utf8");
  writeJson(settingsPath, { modelScan: { directory: "/tmp", maxDepth: 1 } });

  const result = await restoreConfigFiles({
    ref: "HEAD",
    paths: ["settings.json"],
  });

  assert.equal(readFileSync(settingsPath, "utf8"), committed);
  assert.equal(result.status.dirty, false);
});

test("restore recreates a file deleted since the ref", async () => {
  const instancePath = resolve(config.configDir, "instances", "worker.json");
  writeJson(instancePath, instanceRecord("worker"));
  commitAll("add worker");
  rmSync(instancePath);
  commitAll("delete worker");

  await restoreConfigFiles({ ref: "HEAD~1", paths: ["instances/worker.json"] });

  assert.ok(existsSync(instancePath));
  assert.equal(
    (JSON.parse(readFileSync(instancePath, "utf8")) as { name: string }).name,
    "worker",
  );
});

test("rejects unsafe, non-restorable and missing paths", async () => {
  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD", paths: ["../outside.json"] }),
    /invalid configuration path/,
  );
  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD", paths: ["instances/../settings.json"] }),
    /invalid configuration path/,
  );
  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD", paths: [".gitignore"] }),
    /not a restorable configuration file/,
  );
  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD", paths: ["path-catalog.json"] }),
    /not a restorable configuration file/,
  );
  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD", paths: ["instances"] }),
    /not a restorable configuration file/,
  );
  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD", paths: ["instances/ghost.json"] }),
    /does not exist at HEAD/,
  );
  await assert.rejects(
    restoreConfigFiles({ ref: "no-such-ref", paths: ["settings.json"] }),
    /./,
  );
});

test("rejects an old-shape blob without touching the worktree", async () => {
  const instancePath = resolve(config.configDir, "instances", "legacy.json");
  writeFileSync(
    instancePath,
    `${JSON.stringify({ name: "legacy", numaNode: 0 }, null, 2)}\n`,
    "utf8",
  );
  commitAll("legacy shape");
  rmSync(instancePath);
  commitAll("drop legacy");

  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD~1", paths: ["instances/legacy.json"] }),
    /restore validation failed/,
  );
  assert.ok(!existsSync(instancePath));
  assert.equal(git(["status", "--porcelain"]), "");
});

test("cross-file validation failure rolls back every written file", async () => {
  writeJson(resolve(config.configDir, "resources.json"), [
    {
      id: "gpu0",
      name: "GPU 0",
      kind: "gpu",
      capacityBytes: 1024,
      reservedBytes: 0,
      deviceRef: null,
      autoCapacity: false,
    },
  ]);
  writeJson(
    resolve(config.configDir, "instances", "worker.json"),
    instanceRecord("worker", [{ poolId: "gpu0", bytes: 512 }]),
  );
  commitAll("worker draws on gpu0");
  writeJson(resolve(config.configDir, "resources.json"), []);
  rmSync(resolve(config.configDir, "instances", "worker.json"));
  commitAll("remove pool and worker");

  await assert.rejects(
    restoreConfigFiles({ ref: "HEAD~1", paths: ["instances/worker.json"] }),
    /missing resource pool/,
  );
  assert.ok(!existsSync(resolve(config.configDir, "instances", "worker.json")));
  assert.equal(git(["status", "--porcelain"]), "");

  const both = await restoreConfigFiles({
    ref: "HEAD~1",
    paths: ["instances/worker.json", "resources.json"],
  });
  assert.match(both.output, /Restored 2 file/);
  assert.equal(both.validation.valid, true);
});

test("unchanged files are reported without a write", async () => {
  const result = await restoreConfigFiles({
    ref: "HEAD",
    paths: ["settings.json"],
  });
  assert.match(result.output, /Already up to date/);
  assert.equal(result.status.dirty, false);
});

test("per-file diff scopes hunks and commit detail lists files", async () => {
  const settingsPath = resolve(config.configDir, "settings.json");
  writeJson(settingsPath, { modelScan: { directory: "/models", maxDepth: 2 } });
  writeJson(resolve(config.configDir, "nodes.json"), [
    { id: "n1", name: "peer", baseUrl: "http://peer:8787", enabled: true },
  ]);

  const scoped = await getConfigGitDiff("settings.json");
  assert.match(scoped.unstaged, /settings\.json/);
  assert.equal(scoped.unstaged.includes("nodes.json"), false);

  commitAll("both files");
  const detail = await getConfigGitCommit("HEAD");
  assert.deepEqual(
    detail.files.map((file) => `${file.status} ${file.path}`).sort(),
    ["M nodes.json", "M settings.json"],
  );
  assert.ok(detail.tree.includes("proxy/targets.json"));
});
