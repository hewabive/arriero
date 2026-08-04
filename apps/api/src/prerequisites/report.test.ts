import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePrerequisite } from "./report.js";
import type { PrerequisiteDefinition } from "./registry.js";

test("turns explicitly runnable remediation steps into one install command", async () => {
  const definition: PrerequisiteDefinition = {
    id: "test-tool",
    group: "build",
    title: "Test tool",
    kind: "executable",
    severity: "recommended",
    blocks: [],
    impact: "",
    packages: {},
    commands: ["sudo first-step", "sudo second-step"],
    runnableCommands: true,
    docPath: null,
    note: null,
    probe: async () => ({
      status: "missing",
      detail: null,
      version: null,
    }),
  };

  const check = await evaluatePrerequisite(definition, {
    env: {},
    searchDirectories: [],
    usage: {
      cudaBuild: false,
      httpsFeatures: false,
      numaBind: false,
      numaInterleave: false,
      pythonEngines: false,
    },
  });

  assert.equal(
    check.remediation.installCommand,
    "sudo first-step && sudo second-step",
  );
  assert.deepEqual(check.remediation.commands, []);
});
