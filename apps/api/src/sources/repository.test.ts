import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetSettingsCache } from "../settings/store.js";
import {
  createLlamaOriginRepository,
  runFixtureGit,
} from "../test/llama-origin.js";
import {
  cloneSourceRepository,
  pullSourceRepository,
  sweepSourceCloneStaging,
  updateSourceRepositorySettings,
} from "./operations.js";
import {
  cancelSourceRepositoryOperationJob,
  getSourceRepositoryOperationJob,
  resetSourceRepositoryOperationJobsForTests,
  startSourceRepositoryClone,
} from "./jobs.js";
import { LLAMA_CPP_SOURCE_ID } from "./registry.js";
import {
  getSourceRepositorySpec,
  getSourceRepositoryStatus,
  saveSourceRepositoryOrigin,
} from "./repository.js";

function resetSettings(value: unknown = {}) {
  mkdirSync(config.configDir, { recursive: true });
  writeFileSync(
    config.settingsFile,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  resetSettingsCache();
}

function managedSettings() {
  return {
    sourceRepositories: [
      {
        id: LLAMA_CPP_SOURCE_ID,
        adapter: "llama-cpp",
        originUrl: "https://github.com/ggml-org/llama.cpp.git",
        location: { type: "managed" },
        updatedAt: null,
      },
    ],
  };
}

function createInvalidOrigin(name: string): string {
  const path = resolve(config.dataDir, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  runFixtureGit(path, ["init", "-b", "main"]);
  writeFileSync(resolve(path, "README.md"), "not llama.cpp\n");
  runFixtureGit(path, ["add", "."]);
  runFixtureGit(path, ["commit", "-m", "initial"]);
  return path;
}

beforeEach(() => {
  resetSourceRepositoryOperationJobsForTests();
  resetSettings(managedSettings());
  rmSync(config.sourcesDir, { recursive: true, force: true });
  mkdirSync(config.sourcesDir, { recursive: true });
});

async function waitForSourceJob(sourceId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = getSourceRepositoryOperationJob(sourceId);
    if (job && job.status !== "running") return job;
    await new Promise((resolveDone) => setTimeout(resolveDone, 20));
  }
  throw new Error("source job did not finish in time");
}

test("fresh settings use the managed source directory", async () => {
  const originalRootDir = config.rootDir;
  config.rootDir = resolve(config.dataDir, "fresh-root", "manager");
  resetSettings();
  try {
    const spec = getSourceRepositorySpec(LLAMA_CPP_SOURCE_ID);
    const status = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
    assert.deepEqual(spec.location, { type: "managed" });
    assert.equal(status.repoPath, resolve(config.sourcesDir, "llama.cpp"));
    assert.equal(status.state, "missing");
  } finally {
    config.rootDir = originalRootDir;
  }
});

test("a missing legacy sibling default migrates to the managed location", () => {
  const originalRootDir = config.rootDir;
  config.rootDir = resolve(config.dataDir, "legacy-root", "manager");
  resetSettings({
    llamaSource: {
      repoPath: resolve(config.rootDir, "..", "llama.cpp"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  try {
    assert.deepEqual(getSourceRepositorySpec(LLAMA_CPP_SOURCE_ID).location, {
      type: "managed",
    });
  } finally {
    config.rootDir = originalRootDir;
  }
});

test("a custom legacy path remains an external location", () => {
  const customPath = resolve(config.dataDir, "custom-llama.cpp");
  resetSettings({
    llamaSource: {
      repoPath: customPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  assert.deepEqual(getSourceRepositorySpec(LLAMA_CPP_SOURCE_ID).location, {
    type: "external",
    path: customPath,
  });
});

test("an internal directory is not allowed to adopt the manager parent repository", async () => {
  const internalDirectory = resolve(config.rootDir, "apps");
  resetSettings({
    llamaSource: {
      repoPath: internalDirectory,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  const status = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
  assert.equal(status.exists, true);
  assert.equal(status.isGitRepo, false);
  assert.equal(status.valid, false);
  assert.equal(status.state, "invalid");
  assert.ok(
    (status.error ?? "").includes(`Git repository root is ${config.rootDir}`),
  );
});

test("clone publishes a validated managed checkout and persists a fork origin", async () => {
  const origin = createLlamaOriginRepository("llama-origin");
  const originUrl = pathToFileURL(origin).href;

  const cloned = await cloneSourceRepository(LLAMA_CPP_SOURCE_ID, {
    originUrl,
    branch: null,
  });

  assert.equal(cloned.status.state, "ready");
  assert.equal(cloned.status.valid, true);
  assert.equal(cloned.status.spec.originUrl, originUrl);
  assert.equal(cloned.status.remoteUrl, originUrl);
  assert.equal(
    runFixtureGit(cloned.status.repoPath, ["rev-parse", "--show-toplevel"]),
    cloned.status.repoPath,
  );
  const settings = JSON.parse(readFileSync(config.settingsFile, "utf8")) as {
    sourceRepositories: Array<{
      originUrl: string;
      location: { type: string };
    }>;
  };
  assert.equal(settings.sourceRepositories[0]?.originUrl, originUrl);
  assert.deepEqual(settings.sourceRepositories[0]?.location, {
    type: "managed",
  });
});

test("background clone exposes busy state and completes as a source job", async () => {
  const origin = createLlamaOriginRepository("llama-background-origin");
  const originUrl = pathToFileURL(origin).href;

  const started = startSourceRepositoryClone(LLAMA_CPP_SOURCE_ID, {
    originUrl,
    branch: null,
  });
  assert.equal(started.status, "running");
  assert.equal(started.operation, "clone");

  const busy = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
  assert.equal(busy.state, "busy");
  assert.equal(busy.activeOperation, "clone");

  const finished = await waitForSourceJob(LLAMA_CPP_SOURCE_ID);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.phase, "complete");
  assert.equal(finished.progress, 100);
  assert.ok(finished.logLines.some((line) => /Clone completed/.test(line)));

  const ready = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
  assert.equal(ready.state, "ready");
  assert.equal(ready.valid, true);
});

test("background clone can be canceled and cleans its staging checkout", async () => {
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = "sh -c 'sleep 30'";
  try {
    startSourceRepositoryClone(LLAMA_CPP_SOURCE_ID, {
      originUrl: "ssh://git@example.invalid/team/llama.cpp.git",
      branch: null,
    });

    const canceling = cancelSourceRepositoryOperationJob(LLAMA_CPP_SOURCE_ID);
    assert.equal(canceling.cancelRequested, true);

    const finished = await waitForSourceJob(LLAMA_CPP_SOURCE_ID);
    assert.equal(finished.status, "canceled");
    assert.equal(finished.error, "canceled by user");
    assert.equal(existsSync(resolve(config.sourcesDir, "llama.cpp")), false);
    assert.deepEqual(readdirSync(config.sourcesDir), []);
  } finally {
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previousSshCommand;
  }
});

test("failed validation leaves no checkout or staging directory", async () => {
  const originUrl = pathToFileURL(createInvalidOrigin("invalid-origin")).href;

  await assert.rejects(
    cloneSourceRepository(LLAMA_CPP_SOURCE_ID, {
      originUrl,
      branch: null,
    }),
    /does not look like llama\.cpp/,
  );

  assert.equal(existsSync(resolve(config.sourcesDir, "llama.cpp")), false);
  assert.deepEqual(readdirSync(config.sourcesDir), []);
});

test("clone never overwrites an existing target directory", async () => {
  const target = resolve(config.sourcesDir, "llama.cpp");
  const sentinel = resolve(target, "keep.txt");
  mkdirSync(target, { recursive: true });
  writeFileSync(sentinel, "keep\n");

  await assert.rejects(
    cloneSourceRepository(LLAMA_CPP_SOURCE_ID, {
      branch: null,
    }),
    /repository path already exists/,
  );

  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
});

test("startup sweep removes orphaned clone staging directories", () => {
  const managedStaging = resolve(config.sourcesDir, ".source-clone-orphan");
  mkdirSync(resolve(managedStaging, "repository"), { recursive: true });

  const removed = sweepSourceCloneStaging();

  assert.equal(removed, 1);
  assert.equal(existsSync(managedStaging), false);
});

test("origin update changes both portable settings and the Git remote", async () => {
  const firstOrigin = pathToFileURL(
    createLlamaOriginRepository("llama-origin-a"),
  ).href;
  const secondOrigin = pathToFileURL(
    createLlamaOriginRepository("llama-origin-b"),
  ).href;
  await cloneSourceRepository(LLAMA_CPP_SOURCE_ID, {
    originUrl: firstOrigin,
    branch: null,
  });

  const changed = await updateSourceRepositorySettings(LLAMA_CPP_SOURCE_ID, {
    originUrl: secondOrigin,
  });

  assert.equal(changed.status.spec.originUrl, secondOrigin);
  assert.equal(changed.status.remoteUrl, secondOrigin);
  assert.equal(
    runFixtureGit(changed.status.repoPath, ["remote", "get-url", "origin"]),
    secondOrigin,
  );
});

function createVllmOriginRepository(name: string): string {
  const path = resolve(config.dataDir, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(resolve(path, "vllm", "engine"), { recursive: true });
  runFixtureGit(path, ["init", "-b", "main"]);
  writeFileSync(resolve(path, "vllm", "engine", "arg_utils.py"), "ARGS = {}\n");
  runFixtureGit(path, ["add", "."]);
  runFixtureGit(path, ["commit", "-m", "release 0.1.0"]);
  runFixtureGit(path, ["tag", "v0.1.0"]);
  return path;
}

function commitOriginRevision(path: string, message: string, tag?: string) {
  runFixtureGit(path, ["commit", "--allow-empty", "-m", message]);
  if (tag) {
    runFixtureGit(path, ["tag", tag]);
  }
  return runFixtureGit(path, ["rev-parse", "HEAD"]);
}

test("clone of a stable-tag source checks out the latest stable release", async () => {
  const origin = createVllmOriginRepository("vllm-origin");
  const stableCommit = commitOriginRevision(origin, "release 0.2.0", "v0.2.0");
  commitOriginRevision(origin, "pre-release work", "v0.3.0rc1");

  const cloned = await cloneSourceRepository("vllm", {
    originUrl: pathToFileURL(origin).href,
    branch: null,
  });

  assert.equal(cloned.status.state, "ready");
  assert.equal(cloned.status.tracking, "stable-tag");
  assert.equal(cloned.status.currentCommit, stableCommit);
  assert.ok(!cloned.status.branch);
  assert.match(cloned.output, /Checked out v0\.2\.0/);
});

test("pull moves a stable-tag source onto the newest stable release", async () => {
  const origin = createVllmOriginRepository("vllm-pull-origin");
  await cloneSourceRepository("vllm", {
    originUrl: pathToFileURL(origin).href,
    branch: null,
  });

  const releaseCommit = commitOriginRevision(origin, "release 0.4.0", "v0.4.0");
  commitOriginRevision(origin, "pre-release work", "v1.0.0rc1");

  const pulled = await pullSourceRepository("vllm");
  assert.equal(pulled.status.currentCommit, releaseCommit);
  assert.ok(!pulled.status.branch);
  assert.match(pulled.output, /Checked out v0\.4\.0/);

  const repeated = await pullSourceRepository("vllm");
  assert.match(repeated.output, /Already on v0\.4\.0\./);
});

test("pull fast-forwards a branch-tracking source", async () => {
  const origin = createLlamaOriginRepository("llama-pull-origin");
  await cloneSourceRepository(LLAMA_CPP_SOURCE_ID, {
    originUrl: pathToFileURL(origin).href,
    branch: null,
  });

  const nextCommit = commitOriginRevision(origin, "next change");

  const pulled = await pullSourceRepository(LLAMA_CPP_SOURCE_ID);
  assert.equal(pulled.status.currentCommit, nextCommit);
  assert.equal(pulled.status.branch, "main");
  assert.equal(pulled.status.tracking, "branch");
});

test("saving an unchanged origin does not rewrite settings.json", () => {
  resetSettings(managedSettings());
  const spec = getSourceRepositorySpec(LLAMA_CPP_SOURCE_ID);
  const before = statSync(config.settingsFile).mtimeMs;
  saveSourceRepositoryOrigin(LLAMA_CPP_SOURCE_ID, spec.originUrl);
  assert.equal(statSync(config.settingsFile).mtimeMs, before);
});
