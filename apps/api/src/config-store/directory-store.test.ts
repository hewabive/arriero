import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";

import { config } from "../config.js";
import { ConfigFileError, ConfigWriteConflictError } from "./errors.js";
import { createJsonDirectoryStore } from "./directory-store.js";

const testRoot = resolve(config.configDir, "directory-store-test");
const schema = z.object({ name: z.string(), value: z.string().default("") });
type Doc = z.infer<typeof schema>;

let sequence = 0;

function makeStore() {
  sequence += 1;
  const dir = resolve(testRoot, `dir-${sequence}`);
  mkdirSync(dir, { recursive: true });
  return createJsonDirectoryStore<Doc>({
    id: `test:directory-store-${sequence}`,
    dir,
    schema,
    key: (record) => record.name,
    portablePaths: true,
  });
}

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("lists records keyed by record name", () => {
  const store = makeStore();
  store.write({ name: "alpha", value: "1" });
  store.write({ name: "beta", value: "2" });
  assert.deepEqual(
    store
      .list()
      .map((record) => record.name)
      .sort(),
    ["alpha", "beta"],
  );
  assert.equal(store.get("alpha")?.value, "1");
  assert.equal(store.get("missing"), null);
});

test("write with previousKey renames the record file", () => {
  const store = makeStore();
  store.write({ name: "old", value: "1" });
  store.write({ name: "new", value: "1" }, "old");
  assert.equal(existsSync(store.filePath("old")), false);
  assert.equal(existsSync(store.filePath("new")), true);
  assert.equal(store.get("old"), null);
  assert.equal(store.get("new")?.value, "1");
});

test("remove deletes the record file", () => {
  const store = makeStore();
  store.write({ name: "gone", value: "1" });
  assert.equal(store.remove("gone"), true);
  assert.equal(existsSync(store.filePath("gone")), false);
  assert.equal(store.remove("gone"), false);
});

test("write refuses to clobber a record file edited on disk since load", () => {
  const store = makeStore();
  store.write({ name: "guarded", value: "1" });
  writeFileSync(
    store.filePath("guarded"),
    `${JSON.stringify({ name: "guarded", value: "hand-edited" })}\n`,
    "utf8",
  );
  const future = new Date(Date.now() + 5_000);
  utimesSync(store.filePath("guarded"), future, future);
  assert.throws(
    () => store.write({ name: "guarded", value: "2" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigWriteConflictError);
      return true;
    },
  );
});

test("write refuses to overwrite a file that appeared on disk unseen", () => {
  const store = makeStore();
  store.list();
  writeFileSync(
    store.filePath("surprise"),
    `${JSON.stringify({ name: "surprise", value: "external" })}\n`,
    "utf8",
  );
  assert.throws(
    () => store.write({ name: "surprise", value: "mine" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigWriteConflictError);
      return true;
    },
  );
});

test("an invalid file aborts the directory load", () => {
  const store = makeStore();
  store.write({ name: "ok", value: "1" });
  writeFileSync(store.filePath("broken"), "{ nope", "utf8");
  store.reset();
  assert.throws(store.list, (error: unknown) => {
    assert.ok(error instanceof ConfigFileError);
    assert.equal(error.path, store.filePath("broken"));
    return true;
  });
});
