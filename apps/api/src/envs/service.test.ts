import { EnvironmentCreateSchema } from "@arriero/core";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { settleDirectoryDiscards } from "../utils/discard.js";
import { environmentDirectory } from "./paths.js";
import { createEnvironmentSpec, deleteEnvironmentSpec } from "./repository.js";
import { environmentRunner } from "./runner.js";
import { rebuildEnvironment } from "./service.js";

test("rebuild discards a leftover directory and restarts the install", async () => {
  const fakeUvDir = mkdtempSync(join(tmpdir(), "arriero-fake-uv-"));
  writeFileSync(join(fakeUvDir, "uv"), '#!/bin/sh\necho "uv 0.8.0"\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeUvDir}${delimiter}${previousPath ?? ""}`;
  const spec = createEnvironmentSpec(
    EnvironmentCreateSchema.parse({
      engine: "vllm",
      version: "0.24.0",
      pythonVersion: "3.12.13",
      source: { kind: "pypi", extras: [] },
    }),
  );
  const leftover = environmentDirectory(spec);
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "marker"), "stale", "utf8");
  try {
    const result = rebuildEnvironment(spec.id);
    assert.ok(result);
    assert.equal(existsSync(join(leftover, "marker")), false);
    environmentRunner.cancel(result.job.id);
    await environmentRunner.shutdown();
    await settleDirectoryDiscards();
  } finally {
    process.env.PATH = previousPath;
    rmSync(fakeUvDir, { recursive: true, force: true });
    rmSync(leftover, { recursive: true, force: true });
    deleteEnvironmentSpec(spec.id);
  }
});
