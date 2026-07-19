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
    redactGitOutput("ssh://git@example.com/org/config.git"),
    "ssh://***@example.com/org/config.git",
  );
});
