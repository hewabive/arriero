import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import test from "node:test";

import { config } from "../config.js";
import { listPathCatalogEntries } from "../path-catalog/repository.js";
import { LLAMA_CPP_SOURCE_ID } from "../sources/registry.js";
import { withSourceRepositoryOperation } from "../sources/state.js";
import {
  getBuildSettings,
  registerBuiltBinaryInCatalog,
  saveBuildSettings,
} from "./repository.js";

test("saving build settings with an unchanged repo path is allowed during a source operation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const running = withSourceRepositoryOperation(
    LLAMA_CPP_SOURCE_ID,
    "pull",
    () => gate,
  );
  try {
    const settings = getBuildSettings();
    const saved = saveBuildSettings({ ...settings, cuda: !settings.cuda });
    assert.equal(saved.repoPath, settings.repoPath);
    assert.equal(saved.cuda, !settings.cuda);
  } finally {
    release();
    await running;
  }
});

test("registerBuiltBinaryInCatalog creates a binary catalog entry", () => {
  const entry = registerBuiltBinaryInCatalog(
    "/opt/created/bin/llama-server",
    "/path/that/does/not/exist",
  );

  assert.equal(entry.kind, "binary");
  assert.equal(entry.path, "/opt/created/bin/llama-server");
  assert.equal(entry.name, "llama-server");
});

test("registerBuiltBinaryInCatalog includes the ref in the name", () => {
  const entry = registerBuiltBinaryInCatalog(
    "/opt/ref/bin/llama-server",
    "/path/that/does/not/exist",
    "feature-foo",
  );

  assert.equal(entry.name, "llama-server (feature-foo)");
});

test("registerBuiltBinaryInCatalog deduplicates by path", () => {
  const path = "/opt/idempotent/bin/llama-server";
  const first = registerBuiltBinaryInCatalog(path, "/path/that/does/not/exist");
  const second = registerBuiltBinaryInCatalog(
    path,
    "/path/that/does/not/exist",
  );

  assert.equal(first.id, second.id);
  const matches = listPathCatalogEntries("binary").filter(
    (entry) => entry.path === path,
  );
  assert.equal(matches.length, 1);
});

test("registerBuiltBinaryInCatalog tags the engine kind by basename", () => {
  const server = registerBuiltBinaryInCatalog(
    "/opt/tagged/bin/llama-server",
    "/path/that/does/not/exist",
  );
  const rpc = registerBuiltBinaryInCatalog(
    "/opt/tagged/bin/ggml-rpc-server",
    "/path/that/does/not/exist",
  );

  assert.equal(server.engineKind, "llama-server");
  assert.equal(rpc.engineKind, "rpc-worker");
});

test("registerBuiltBinaryInCatalog backfills the engine kind on re-register", () => {
  const path = "/opt/backfill/bin/llama-server";
  const first = registerBuiltBinaryInCatalog(path, "/path/that/does/not/exist");
  const second = registerBuiltBinaryInCatalog(
    path,
    "/path/that/does/not/exist",
  );

  assert.equal(first.id, second.id);
  assert.equal(second.engineKind, "llama-server");
});

test("registerBuiltBinaryInCatalog disambiguates colliding names", () => {
  const a = registerBuiltBinaryInCatalog(
    "/opt/collide-a/bin/llama-cli",
    "/path/that/does/not/exist",
  );
  const b = registerBuiltBinaryInCatalog(
    "/opt/collide-b/bin/llama-cli",
    "/path/that/does/not/exist",
  );

  assert.equal(a.name, "llama-cli");
  assert.notEqual(a.name, b.name);
  assert.notEqual(a.id, b.id);
});

test("saving unchanged build settings does not rewrite settings.json", () => {
  saveBuildSettings(getBuildSettings());
  const before = statSync(config.settingsFile).mtimeMs;
  saveBuildSettings(getBuildSettings());
  assert.equal(statSync(config.settingsFile).mtimeMs, before);
});
