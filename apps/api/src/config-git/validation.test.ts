import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { validateConfigBlob, validateConfigRoot } from "./validation.js";

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("validateConfigRoot accepts a minimal portable configuration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-valid-"));
  mkdirSync(resolve(root, "instances"));
  mkdirSync(resolve(root, "proxy"));
  writeJson(resolve(root, "settings.json"), {});
  writeJson(resolve(root, "argument-defaults.json"), { instance: [] });
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "path-catalog.json"), []);
  writeJson(resolve(root, "envs.json"), []);
  writeJson(resolve(root, "nodes.json"), []);
  for (const name of [
    "targets",
    "models",
    "pipelines",
    "endpoints",
    "sources",
  ]) {
    writeJson(resolve(root, "proxy", `${name}.json`), []);
  }

  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });
});

test("validateConfigRoot tolerates dangling machine-state references", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-machine-"));
  mkdirSync(resolve(root, "instances"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "llama-server",
    binaryPath: "/bin/false",
    binaryPathRefId: "no-such-catalog-entry",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });
});

test("validateConfigRoot rejects a repository without configuration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-empty-"));
  writeFileSync(resolve(root, "README.md"), "empty profile\n");

  const result = validateConfigRoot(root);
  assert.equal(result.valid, false);
  assert.match(result.issues[0]?.message ?? "", /no recognized configuration/);
});

test("validateConfigBlob validates a single file by its path kind", () => {
  assert.deepEqual(validateConfigBlob("settings.json", "{}"), []);
  assert.deepEqual(
    validateConfigBlob(
      "instances/worker.json",
      JSON.stringify({
        name: "worker",
        kind: "llama-server",
        binaryPath: "/bin/false",
        args: {},
        env: {},
        memory: [],
        rpcWorkers: [],
      }),
    ),
    [],
  );

  const mismatch = validateConfigBlob(
    "instances/worker.json",
    JSON.stringify({
      name: "other",
      kind: "llama-server",
      binaryPath: "/bin/false",
      args: {},
      env: {},
      memory: [],
      rpcWorkers: [],
    }),
  );
  assert.match(mismatch[0]?.message ?? "", /does not match file name/);

  const invalid = validateConfigBlob("instances/worker.json", "{}");
  assert.equal(invalid.length > 0, true);

  const badIni = validateConfigBlob(
    "presets/router.ini",
    "[model]\nno equals sign here\n",
  );
  assert.equal(badIni.length > 0, true);

  assert.match(
    validateConfigBlob("path-catalog.json", "[]")[0]?.message ?? "",
    /not a restorable/,
  );
  assert.match(
    validateConfigBlob("README.md", "hello")[0]?.message ?? "",
    /not a restorable/,
  );
});

test("validateConfigRoot rejects symlinks and broken resource references", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-invalid-"));
  mkdirSync(resolve(root, "instances"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "path-catalog.json"), []);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "llama-server",
    binaryPath: "/bin/false",
    args: {},
    env: {},
    memory: [{ poolId: "missing", bytes: 1 }],
    rpcWorkers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  symlinkSync("/tmp", resolve(root, "outside"));

  const result = validateConfigRoot(root);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.message.includes("symbolic links")),
  );
  assert.ok(
    result.issues.some((issue) =>
      issue.message.includes("missing resource pool"),
    ),
  );
});
