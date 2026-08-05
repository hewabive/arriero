import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../config.js";
import { assertGitRemoteUrl, redactGitOutput, runGit } from "./process.js";

test("source origins accept credential-free network and file URLs", () => {
  for (const value of [
    "https://github.com/ggml-org/llama.cpp.git",
    "http://gitea.lan/mirrors/llama.cpp.git",
    "ssh://git@example.com/team/llama.cpp.git",
    "git@example.com:team/llama.cpp.git",
    "file:///srv/git/llama.cpp",
  ]) {
    assert.doesNotThrow(() =>
      assertGitRemoteUrl(value, { allowFile: true, allowHttp: true }),
    );
  }
});

test("source origins reject credentials and unsupported protocols", () => {
  assert.throws(
    () =>
      assertGitRemoteUrl("https://token@example.com/team/repo.git", {
        allowFile: true,
        allowHttp: true,
      }),
    /credentials/,
  );
  assert.throws(
    () =>
      assertGitRemoteUrl("http://token@example.com/team/repo.git", {
        allowFile: true,
        allowHttp: true,
      }),
    /credentials/,
  );
  assert.throws(
    () =>
      assertGitRemoteUrl("git://example.com/team/repo.git", {
        allowFile: true,
        allowHttp: true,
      }),
    /must use/,
  );
});

test("origins without allowHttp keep rejecting plain http", () => {
  assert.throws(
    () => assertGitRemoteUrl("http://example.com/team/repo.git"),
    /must use SSH or HTTPS/,
  );
});

test("Git output redacts URL credentials", () => {
  assert.equal(
    redactGitOutput("https://user:token@example.com/team/repo.git"),
    "https://***@example.com/team/repo.git",
  );
  assert.equal(
    redactGitOutput("https://token@example.com/team/repo.git"),
    "https://***@example.com/team/repo.git",
  );
});

test("Git output keeps the SSH login name, which is not a credential", () => {
  assert.equal(
    redactGitOutput("ssh://git@example.com:2222/team/repo.git"),
    "ssh://git@example.com:2222/team/repo.git",
  );
});

test("runGit aborts a cancellable Git process group", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runGit(
    config.rootDir,
    ["-c", "alias.wait=!sleep 30", "wait"],
    {
      timeoutMs: 35_000,
      signal: controller.signal,
      killProcessGroup: true,
    },
  );

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(running, /git command canceled/);
  assert.ok(Date.now() - startedAt < 5_000);
});
