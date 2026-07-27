import assert from "node:assert/strict";
import test from "node:test";

import { updateStepEnvironment } from "./runner.js";

test("updateStepEnvironment makes pnpm install non-interactive", () => {
  const base = { PATH: "/tools", CI: "false", CUSTOM: "kept" };

  const environment = updateStepEnvironment("install", base);

  assert.notEqual(environment, base);
  assert.deepEqual(environment, {
    PATH: "/tools",
    CI: "true",
    CUSTOM: "kept",
  });
  assert.equal(base.CI, "false");
});

test("updateStepEnvironment leaves other update steps unchanged", () => {
  const base = { PATH: "/tools" };

  assert.equal(updateStepEnvironment("git-pull", base), base);
  assert.equal(updateStepEnvironment("build", base), base);
});
