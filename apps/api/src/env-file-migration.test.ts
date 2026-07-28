import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyEnvFile } from "./env-file-migration.js";

function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arriero-env-migration-"));
  const path = join(dir, ".env");
  writeFileSync(path, content);
  return path;
}

test("renames legacy assignments and leaves everything else intact", () => {
  const path = envFile(
    [
      "# arriero runtime configuration.",
      "LLAMA_MANAGER_HOST=127.0.0.1",
      "  export LLAMA_MANAGER_PORT = 8787",
      "",
      "# LLAMA_MANAGER_SECURE_COOKIE=false",
      "OPENROUTER_API_KEY=sk-legacy-LLAMA_MANAGER_PORT",
      "",
    ].join("\n"),
  );

  const result = migrateLegacyEnvFile(path);

  assert.deepEqual(result?.renamed, [
    "LLAMA_MANAGER_HOST",
    "LLAMA_MANAGER_PORT",
  ]);
  assert.deepEqual(result?.conflicts, []);
  assert.equal(
    readFileSync(path, "utf8"),
    [
      "# arriero runtime configuration.",
      "ARRIERO_HOST=127.0.0.1",
      "  export ARRIERO_PORT = 8787",
      "",
      "# LLAMA_MANAGER_SECURE_COOKIE=false",
      "OPENROUTER_API_KEY=sk-legacy-LLAMA_MANAGER_PORT",
      "",
    ].join("\n"),
  );
});

test("keeps a legacy line whose ARRIERO_ name is already set", () => {
  const path = envFile(
    ["ARRIERO_PORT=8787", "LLAMA_MANAGER_PORT=9999", ""].join("\n"),
  );

  const result = migrateLegacyEnvFile(path);

  assert.deepEqual(result?.renamed, []);
  assert.deepEqual(result?.conflicts, ["LLAMA_MANAGER_PORT"]);
  assert.equal(
    readFileSync(path, "utf8"),
    ["ARRIERO_PORT=8787", "LLAMA_MANAGER_PORT=9999", ""].join("\n"),
  );
});

test("renames the unambiguous entries of a partially conflicting file", () => {
  const path = envFile(
    [
      "ARRIERO_PORT=8787",
      "LLAMA_MANAGER_PORT=9999",
      "LLAMA_MANAGER_HOST=0.0.0.0",
      "",
    ].join("\n"),
  );

  const result = migrateLegacyEnvFile(path);

  assert.deepEqual(result?.renamed, ["LLAMA_MANAGER_HOST"]);
  assert.deepEqual(result?.conflicts, ["LLAMA_MANAGER_PORT"]);
  assert.equal(
    readFileSync(path, "utf8"),
    [
      "ARRIERO_PORT=8787",
      "LLAMA_MANAGER_PORT=9999",
      "ARRIERO_HOST=0.0.0.0",
      "",
    ].join("\n"),
  );
});

test("preserves the file mode of a rewritten file", () => {
  const path = envFile("LLAMA_MANAGER_ADMIN_PASSWORD=secret\n");
  chmodSync(path, 0o600);

  migrateLegacyEnvFile(path);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8"), "ARRIERO_ADMIN_PASSWORD=secret\n");
});

test("rewrites through a symlink without replacing it", () => {
  const path = envFile("LLAMA_MANAGER_HOST=127.0.0.1\n");
  const link = join(path, "..", ".env.link");
  symlinkSync(path, link);

  const result = migrateLegacyEnvFile(link);

  assert.equal(result?.path, path);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(path, "utf8"), "ARRIERO_HOST=127.0.0.1\n");
});

test("returns null for a file without legacy entries", () => {
  const path = envFile("ARRIERO_HOST=127.0.0.1\n");
  assert.equal(migrateLegacyEnvFile(path), null);
});

test("returns null for a missing file", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "arriero-env-migration-")),
    ".env",
  );
  assert.equal(migrateLegacyEnvFile(path), null);
});
