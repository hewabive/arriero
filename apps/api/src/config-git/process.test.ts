import assert from "node:assert/strict";
import { test } from "node:test";

import { redactGitOutput } from "./process.js";

test("redactGitOutput removes URL credentials", () => {
  assert.equal(
    redactGitOutput(
      "fatal: https://alice:secret@example.com/org/config.git denied",
    ),
    "fatal: https://***@example.com/org/config.git denied",
  );
  assert.equal(
    redactGitOutput("ssh://git@example.com:2222/org/config.git"),
    "ssh://git@example.com:2222/org/config.git",
  );
  assert.equal(
    redactGitOutput("ssh://git:secret@example.com/org/config.git"),
    "ssh://git:***@example.com/org/config.git",
  );
});
