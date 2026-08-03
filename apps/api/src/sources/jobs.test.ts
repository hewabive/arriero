import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSourceGitProgress } from "./jobs.js";

test("clone Git progress is mapped to monotonic overall phases", () => {
  assert.deepEqual(
    parseSourceGitProgress(
      "clone",
      "Receiving objects:  50% (500/1000), 4.00 MiB | 1.00 MiB/s",
    ),
    {
      phase: "receiving",
      progress: 38,
      message: "Receiving objects:  50% (500/1000), 4.00 MiB | 1.00 MiB/s",
    },
  );
  assert.equal(
    parseSourceGitProgress("clone", "Resolving deltas: 50% (100/200)")
      ?.progress,
    80,
  );
  assert.equal(
    parseSourceGitProgress("clone", "Updating files: 100% (200/200)")?.progress,
    97,
  );
});

test("unrelated Git output remains a log line without fake progress", () => {
  assert.equal(parseSourceGitProgress("pull", "Already up to date."), null);
});
