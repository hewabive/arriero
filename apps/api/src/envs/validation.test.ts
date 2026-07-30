import { EnvironmentSpecSchema } from "@arriero/core";
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
  writeFileSync(resolve(directory, "bin", "python"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  writeFileSync(
    resolve(directory, "bin", "vllm"),
    `#!${environmentStagingDirectory(spec)}/bin/python\n`,
    { mode: 0o755 },
  );
  writeFileSync(resolve(directory, "freeze.txt"), "vllm==0.24.0\n", "utf8");

  assert.match(environmentLayoutError(spec) ?? "", /staging directory/);

  writeFileSync(
    resolve(directory, "bin", "vllm"),
    '#!/bin/sh\nexec "$(dirname "$0")/python" "$0" "$@"\n',
    { mode: 0o755 },
  );
  assert.equal(environmentLayoutError(spec), null);
  rmSync(directory, { recursive: true, force: true });
});

const ktSpec = EnvironmentSpecSchema.parse({
  engine: "ktransformers",
  version: "0.6.3.post1",
  pythonVersion: "3.12",
  id: "kt-layout-validation-test",
  pathCatalogEntryId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("KTransformers layout requires roots and the CLI compatibility pin", () => {
  const directory = environmentDirectory(ktSpec);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(resolve(directory, "bin"), { recursive: true });
  writeFileSync(resolve(directory, "bin", "python"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  writeFileSync(resolve(directory, "bin", "sglang"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  writeFileSync(
    resolve(directory, "freeze.txt"),
    "kt-kernel==0.6.3.post1\n",
    "utf8",
  );

  assert.match(environmentLayoutError(ktSpec) ?? "", /remote-pdb/);

  writeFileSync(
    resolve(directory, "freeze.txt"),
    "kt-kernel==0.6.3.post1\nremote-pdb==2.1.0\n",
    "utf8",
  );
  assert.match(environmentLayoutError(ktSpec) ?? "", /sglang-kt/);

  writeFileSync(
    resolve(directory, "freeze.txt"),
    "KT-Kernel==0.6.3.post1\nremote-pdb==2.1.0\nsglang-kt==0.6.3.post1\n",
    "utf8",
  );
  assert.equal(environmentLayoutError(ktSpec), null);
  rmSync(directory, { recursive: true, force: true });
});
