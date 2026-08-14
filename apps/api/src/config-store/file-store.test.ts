import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";

import { config } from "../config.js";
import { ConfigFileError } from "./errors.js";
import {
  createJsonFileStore,
  type ConfigCacheMode,
  type JsonFileStoreOptions,
} from "./file-store.js";

const testDir = resolve(config.configDir, "config-store-test");
const schema = z.object({ path: z.string(), count: z.number().default(0) });
type Doc = z.infer<typeof schema>;

let sequence = 0;

function makeStore(
  cache: ConfigCacheMode,
  overrides: Partial<JsonFileStoreOptions<Doc>> = {},
) {
  sequence += 1;
  mkdirSync(testDir, { recursive: true });
  return createJsonFileStore<Doc>({
    id: `test:file-store-${sequence}`,
    path: resolve(testDir, `store-${sequence}.json`),
    schema,
    missing: () => ({ path: "/missing" }),
    portablePaths: true,
    cache,
    ...overrides,
  });
}

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("missing file yields the parsed missing value", () => {
  const store = makeStore("per-read");
  assert.deepEqual(store.read(), { path: "/missing", count: 0 });
});

test("malformed JSON throws ConfigFileError with the file path", () => {
  const store = makeStore("per-read");
  writeFileSync(store.path, "{ nope", "utf8");
  assert.throws(store.read, (error: unknown) => {
    assert.ok(error instanceof ConfigFileError);
    assert.equal(error.stage, "json");
    assert.equal(error.path, store.path);
    assert.match(error.message, /Invalid JSON in/);
    return true;
  });
});

test("schema violation throws ConfigFileError with the file path", () => {
  const store = makeStore("per-read");
  writeFileSync(store.path, `${JSON.stringify({ path: 5 })}\n`, "utf8");
  assert.throws(store.read, (error: unknown) => {
    assert.ok(error instanceof ConfigFileError);
    assert.equal(error.stage, "schema");
    assert.equal(error.path, store.path);
    assert.match(error.message, /Invalid config in/);
    return true;
  });
});

test("write stores placeholders and read returns absolute paths", () => {
  const store = makeStore("process");
  const absolute = resolve(config.runtimeDir, "builds/master/bin/llama-server");
  store.write({ path: absolute, count: 1 });
  const raw = readFileSync(store.path, "utf8");
  assert.match(raw, /\$\{ARRIERO_RUNTIME_DIR\}/);
  assert.equal(raw.includes(config.runtimeDir), false);
  store.reset();
  assert.equal(store.read().path, absolute);
});

test("process cache ignores external edits until reset", () => {
  const store = makeStore("process");
  store.write({ path: "/a", count: 1 });
  writeFileSync(
    store.path,
    `${JSON.stringify({ path: "/b", count: 2 })}\n`,
    "utf8",
  );
  assert.equal(store.read().count, 1);
  store.reset();
  assert.equal(store.read().count, 2);
});

test("per-read store picks up external edits immediately", () => {
  const store = makeStore("per-read");
  store.write({ path: "/a", count: 1 });
  writeFileSync(
    store.path,
    `${JSON.stringify({ path: "/b", count: 2 })}\n`,
    "utf8",
  );
  assert.equal(store.read().count, 2);
});

test("render shapes the serialized document", () => {
  const store = makeStore("per-read", {
    render: (value) => ({ path: value.path }),
  });
  store.write({ path: "/a", count: 7 });
  const raw = JSON.parse(readFileSync(store.path, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(raw, { path: "/a" });
  assert.equal(store.read().count, 0);
});

test("replaceCachedValue swaps memory without touching disk", () => {
  const store = makeStore("process");
  store.write({ path: "/a", count: 1 });
  store.replaceCachedValue({ path: "/a", count: 5 });
  assert.equal(store.read().count, 5);
  const raw = JSON.parse(readFileSync(store.path, "utf8")) as { count: number };
  assert.equal(raw.count, 1);
  store.reset();
  assert.equal(store.read().count, 1);
});

test("replaceCachedValue is rejected on per-read stores", () => {
  const store = makeStore("per-read");
  assert.throws(
    () => store.replaceCachedValue({ path: "/a", count: 1 }),
    /does not cache values/,
  );
});
