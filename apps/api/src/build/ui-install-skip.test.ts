import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, test } from "node:test";

import {
  UI_BUILD_STATE_FILE,
  readUiTreeState,
  recordUiTreeHash,
  resetUiBuildStateCacheForTests,
  storedUiTreeHash,
  uiInstallRunReason,
} from "./ui-install-skip.js";

function git(cwd: string, args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.email=test@test", "-c", "user.name=test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function makeUiRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arriero-ui-skip-"));
  git(repo, ["init", "-q"]);
  mkdirSync(resolve(repo, "tools", "ui"), { recursive: true });
  writeFileSync(resolve(repo, "tools", "ui", "package.json"), "{}\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

beforeEach(() => {
  rmSync(UI_BUILD_STATE_FILE, { force: true });
  resetUiBuildStateCacheForTests();
});

test("readUiTreeState reports the tools/ui tree hash of a clean checkout", async () => {
  const repo = makeUiRepo();
  try {
    const state = await readUiTreeState(repo);
    assert.equal(state.treeHash, git(repo, ["rev-parse", "HEAD:tools/ui"]));
    assert.equal(state.clean, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("readUiTreeState flags local modifications under tools/ui", async () => {
  const repo = makeUiRepo();
  try {
    writeFileSync(resolve(repo, "tools", "ui", "extra.ts"), "export {};\n");
    const state = await readUiTreeState(repo);
    assert.notEqual(state.treeHash, null);
    assert.equal(state.clean, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("readUiTreeState returns no hash outside a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-ui-plain-"));
  try {
    const state = await readUiTreeState(dir);
    assert.equal(state.treeHash, null);
    assert.equal(state.clean, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recorded tree hash round-trips per repo path", () => {
  assert.equal(storedUiTreeHash("/repo/a"), null);
  recordUiTreeHash("/repo/a", "aaa");
  recordUiTreeHash("/repo/b", "bbb");
  assert.equal(storedUiTreeHash("/repo/a"), "aaa");
  assert.equal(storedUiTreeHash("/repo/b"), "bbb");
  resetUiBuildStateCacheForTests();
  assert.equal(storedUiTreeHash("/repo/a"), "aaa");
  recordUiTreeHash("/repo/a", "ccc");
  assert.equal(storedUiTreeHash("/repo/a"), "ccc");
});

test("uiInstallRunReason skips only a clean, unchanged tree with existing dist", () => {
  const state = { treeHash: "abc", clean: true };
  assert.equal(uiInstallRunReason(state, "abc", true), null);
  assert.match(
    uiInstallRunReason({ treeHash: null, clean: true }, "abc", true) ?? "",
    /unavailable/,
  );
  assert.match(
    uiInstallRunReason({ treeHash: "abc", clean: false }, "abc", true) ?? "",
    /local modifications/,
  );
  assert.match(
    uiInstallRunReason(state, "abc", false) ?? "",
    /dist is missing/,
  );
  assert.match(uiInstallRunReason(state, null, true) ?? "", /no recorded/);
  assert.match(uiInstallRunReason(state, "old", true) ?? "", /changed since/);
});
