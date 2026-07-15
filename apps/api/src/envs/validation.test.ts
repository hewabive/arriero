import { EnvironmentSpecSchema } from "@llama-manager/core";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { environmentDirectory, environmentStagingDirectory } from "./paths.js";
import { environmentLayoutError } from "./validation.js";

const spec = EnvironmentSpecSchema.parse({
  engine: "vllm",
  version: "0.24.0",
  pythonVersion: "3.12.3",
  source: { kind: "pypi", extras: [], indexUrl: null },
  id: "layout-validation-test",
  pathCatalogEntryId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("environment layout rejects stale staging launchers", () => {
  const directory = environmentDirectory(spec);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(resolve(directory, "bin"), { recursive: true });
  writeFileSync(resolve(directory, "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(
    resolve(directory, "bin", "vllm"),
    `#!${environmentStagingDirectory(spec)}/bin/python\n`,
    { mode: 0o755 },
  );
  writeFileSync(resolve(directory, "freeze.txt"), "vllm==0.24.0\n", "utf8");

  assert.match(environmentLayoutError(spec) ?? "", /staging directory/);

  writeFileSync(
    resolve(directory, "bin", "vllm"),
    "#!/bin/sh\nexec \"$(dirname \"$0\")/python\" \"$0\" \"$@\"\n",
    { mode: 0o755 },
  );
  assert.equal(environmentLayoutError(spec), null);
  rmSync(directory, { recursive: true, force: true });
});
