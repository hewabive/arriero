import assert from "node:assert/strict";
import test from "node:test";

import { uvPythonPreflightCommand } from "./uv.js";

test("uv Python preflight is local-only and requires a managed interpreter", () => {
  const command = uvPythonPreflightCommand("/usr/bin/uv", "3.12.13");
  assert.deepEqual(command.slice(0, 3), ["/usr/bin/uv", "python", "find"]);
  assert.ok(command.includes("--managed-python"));
  assert.ok(command.includes("--no-python-downloads"));
  assert.equal(command.at(-1), "3.12.13");
});
