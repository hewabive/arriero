import assert from "node:assert/strict";
import { test } from "node:test";

import { assertGitRemoteUrl, redactGitOutput } from "./process.js";

test("source origins accept credential-free network and file URLs", () => {
  for (const value of [
    "https://github.com/ggml-org/llama.cpp.git",
    "ssh://git@example.com/team/llama.cpp.git",
    "git@example.com:team/llama.cpp.git",
    "file:///srv/git/llama.cpp",
  ]) {
    assert.doesNotThrow(() => assertGitRemoteUrl(value, { allowFile: true }));
  }
});

test("source origins reject credentials and unsupported protocols", () => {
  assert.throws(
    () =>
      assertGitRemoteUrl("https://token@example.com/team/repo.git", {
        allowFile: true,
      }),
    /credentials/,
  );
  assert.throws(
    () =>
      assertGitRemoteUrl("http://example.com/team/repo.git", {
        allowFile: true,
      }),
    /must use/,
  );
});

test("Git output redacts URL credentials", () => {
  assert.equal(
    redactGitOutput("https://user:token@example.com/team/repo.git"),
    "https://***@example.com/team/repo.git",
  );
});
