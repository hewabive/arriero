import assert from "node:assert/strict";
import { test } from "node:test";

import { resetProcessRequirement } from "./reset-guard.js";

function file(index: string, worktree: string, path: string) {
  return { index, worktree, path };
}

test("reverting tracked non-settings files needs no process stop", () => {
  const requirement = resetProcessRequirement(
    [
      file(" ", "M", "proxy/models.json"),
      file(" ", "M", "instances/qwen.json"),
      file(" ", "D", "presets/router.ini"),
    ],
    false,
    ["qwen"],
  );
  assert.deepEqual(requirement, { scope: "none" });
});

test("a dirty settings.json requires full quiescence", () => {
  assert.deepEqual(
    resetProcessRequirement([file(" ", "M", "settings.json")], false, []),
    { scope: "all-processes" },
  );
});

test("an untracked settings.json matters only with includeUntracked", () => {
  const files = [file("?", "?", "settings.json")];
  assert.deepEqual(resetProcessRequirement(files, false, []), {
    scope: "none",
  });
  assert.deepEqual(resetProcessRequirement(files, true, []), {
    scope: "all-processes",
  });
});

test("a renamed-away settings.json still requires full quiescence", () => {
  assert.deepEqual(
    resetProcessRequirement(
      [file("R", " ", "settings.json -> settings-backup.json")],
      false,
      [],
    ),
    { scope: "all-processes" },
  );
});

test("deleting the staged file of an active instance is refused", () => {
  const staged = [file("A", " ", "instances/qwen.json")];
  assert.deepEqual(resetProcessRequirement(staged, false, ["qwen"]), {
    scope: "deleted-instances",
    instanceIds: ["qwen"],
  });
  assert.deepEqual(resetProcessRequirement(staged, false, ["other"]), {
    scope: "none",
  });
});

test("untracked instance files block only with includeUntracked", () => {
  const files = [file("?", "?", "instances/qwen.json")];
  assert.deepEqual(resetProcessRequirement(files, false, ["qwen"]), {
    scope: "none",
  });
  assert.deepEqual(resetProcessRequirement(files, true, ["qwen"]), {
    scope: "deleted-instances",
    instanceIds: ["qwen"],
  });
});

test("a staged instance rename blocks on the disappearing destination", () => {
  assert.deepEqual(
    resetProcessRequirement(
      [file("R", " ", "instances/old.json -> instances/new.json")],
      false,
      ["new", "old"],
    ),
    { scope: "deleted-instances", instanceIds: ["new"] },
  );
});
