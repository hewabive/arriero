import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import {
  cloneSourceRepository,
  sweepSourceCloneStaging,
  updateSourceRepositorySettings,
} from "./operations.js";
import { LLAMA_CPP_SOURCE_ID } from "./registry.js";
import {
  getSourceRepositorySpec,
  getSourceRepositoryStatus,
} from "./repository.js";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Source Test",
      GIT_AUTHOR_EMAIL: "source@example.com",
      GIT_COMMITTER_NAME: "Source Test",
      GIT_COMMITTER_EMAIL: "source@example.com",
    },
  }).trim();
}

function resetSettings(value: unknown = {}) {
  mkdirSync(config.configDir, { recursive: true });
  writeFileSync(
    config.settingsFile,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
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

function createLlamaOrigin(name: string): string {
  const path = resolve(config.dataDir, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  writeFileSync(
    resolve(path, "CMakeLists.txt"),
    "cmake_minimum_required(VERSION 3.20)\n",
  );
  writeFileSync(resolve(path, "README.md"), "test llama.cpp source\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

function createInvalidOrigin(name: string): string {
  const path = resolve(config.dataDir, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  writeFileSync(resolve(path, "README.md"), "not llama.cpp\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

beforeEach(() => {
  resetSettings(managedSettings());
  rmSync(config.sourcesDir, { recursive: true, force: true });
  mkdirSync(config.sourcesDir, { recursive: true });
});

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
  const origin = createLlamaOrigin("llama-origin");
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
    git(cloned.status.repoPath, ["rev-parse", "--show-toplevel"]),
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
  const firstOrigin = pathToFileURL(createLlamaOrigin("llama-origin-a")).href;
  const secondOrigin = pathToFileURL(createLlamaOrigin("llama-origin-b")).href;
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
    git(changed.status.repoPath, ["remote", "get-url", "origin"]),
    secondOrigin,
  );
});
