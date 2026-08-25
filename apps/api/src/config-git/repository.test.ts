import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { config } from "../config.js";
import { ConfigBusyError } from "./busy.js";
import { deleteConfigBackup } from "./repository.js";
import { withConfigGitOperation } from "./state.js";

const parent = dirname(config.configDir);
const prefix = `${basename(config.configDir)}.backup-`;

function makeBackup(stamp: string): string {
  const path = resolve(parent, `${prefix}${stamp}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(resolve(path, "settings.json"), "{}", "utf8");
  return path;
}

afterEach(() => {
  for (const stamp of ["111", "222"]) {
    rmSync(resolve(parent, `${prefix}${stamp}`), {
      recursive: true,
      force: true,
    });
  }
});

test("deleteConfigBackup removes the directory and returns the remaining backups", async () => {
  const first = makeBackup("111");
  const second = makeBackup("222");

  const result = await deleteConfigBackup(`${prefix}111`);

  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), true);
  assert.deepEqual(result.backups, [second]);
});

test("deleteConfigBackup rejects names that are not backup directories", async () => {
  const kept = makeBackup("222");

  await assert.rejects(
    deleteConfigBackup(basename(config.configDir)),
    /not a config backup name/,
  );
  await assert.rejects(
    deleteConfigBackup(`../${prefix}222`),
    /not a config backup name/,
  );
  await assert.rejects(
    deleteConfigBackup(`${prefix}999`),
    /config backup not found/,
  );
  assert.equal(existsSync(kept), true);
});

test("deleteConfigBackup refuses while another config git operation runs", async () => {
  const kept = makeBackup("222");

  await withConfigGitOperation("test-operation", async () => {
    await assert.rejects(deleteConfigBackup(`${prefix}222`), ConfigBusyError);
  });

  assert.equal(existsSync(kept), true);
});
