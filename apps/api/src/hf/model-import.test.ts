import {
  createPreset,
  writePreset,
  readPreset,
} from "../presets/repository.js";
import { createInstance, getInstance } from "../instances/repository.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { config } from "../config.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import { readHfManifest } from "./manifest.js";
import {
  startModelImport,
  getModelImport,
  commitModelImport,
} from "./model-import.js";
import type { ModelImportRequest, ModelImportState } from "@arriero/core";

function fixture() {
  const root = join(config.dataDir, `import-${randomUUID()}`);
  const source = join(root, "archive");
  const target = join(root, "library");
  mkdirSync(source, { recursive: true });
  mkdirSync(target);
  saveModelScanSettings({ directory: target, maxDepth: 8 });
  saveHfDownloadSettings({ modelDirectoryId: null, maxEtaHours: null });
  return { source, target };
}

function mockHub(files: Record<string, string>): typeof fetch {
  return (async (url: string | URL | Request) =>
    new Response(
      JSON.stringify(
        String(url).includes("/tree/")
          ? Object.entries(files).map(([path, content]) => ({
              type: "file",
              path,
              size: Buffer.byteLength(content),
              oid: "a".repeat(40),
              lfs: {
                size: Buffer.byteLength(content),
                oid: createHash("sha256").update(content).digest("hex"),
              },
            }))
          : { sha: "b".repeat(40) },
      ),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

async function wait(id: string): Promise<ModelImportState> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = getModelImport(id)!;
    if (!["checking", "importing"].includes(state.status)) return state;
    await setTimeout(10);
  }
  throw new Error("Import did not settle");
}

async function prepare(
  sourcePath: string,
  files: Record<string, string>,
  overrides: Partial<ModelImportRequest> = {},
) {
  return wait(
    startModelImport(
      {
        sourcePath,
        scope: "gguf",
        repo: "owner/model",
        revision: "main",
        remotePath: "",
        ...overrides,
      },
      { fetchImpl: mockHub(files), token: null },
    ).id,
  );
}

test("imports a renamed single GGUF without touching neighboring files", async () => {
  const { source, target } = fixture();
  writeFileSync(join(source, "unknown.gguf"), "weights");
  writeFileSync(join(source, "other.gguf"), "other");
  const state = await prepare(join(source, "unknown.gguf"), {
    "quants/model.gguf": "weights",
  });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(existsSync(join(target, "owner/model")), false);
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(
    readFileSync(join(target, "owner/model/quants/model.gguf"), "utf8"),
    "weights",
  );
  assert.equal(existsSync(join(source, "unknown.gguf")), false);
  assert.equal(readFileSync(join(source, "other.gguf"), "utf8"), "other");
  const manifest = readHfManifest(join(target, "owner/model"));
  assert.equal(manifest?.acquisition, "imported");
  assert.equal(manifest?.files.length, 1);
});

test("imports all GGUF shards and keeps unrelated files", async () => {
  const { source, target } = fixture();
  const files = {
    "model-00001-of-00002.gguf": "first",
    "model-00002-of-00002.gguf": "second",
  };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(source, name), content);
  writeFileSync(join(source, "notes.txt"), "keep");
  const state = await prepare(join(source, Object.keys(files)[0]!), files);
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.files.length, 2);
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "succeeded");
  assert.equal(readHfManifest(join(target, "owner/model"))?.files.length, 2);
  assert.equal(existsSync(join(source, "notes.txt")), true);
});

test("moves safetensors directories with configs, tokenizer and local companions", async () => {
  const { source, target } = fixture();
  const files = {
    "model-00001-of-00002.safetensors": "one",
    "model-00002-of-00002.safetensors": "two",
    "model.safetensors.index.json": JSON.stringify({
      weight_map: {
        a: "model-00001-of-00002.safetensors",
        b: "model-00002-of-00002.safetensors",
      },
    }),
    "config.json": "{}",
    "tokenizer.json": "{}",
  };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(source, name), content);
  writeFileSync(join(source, "notes.txt"), "local notes");
  const state = await prepare(source, files, { scope: "directory" });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.files.filter((file) => !file.verified).length, 1);
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(existsSync(source), false);
  assert.equal(
    readFileSync(join(target, "owner/model/notes.txt"), "utf8"),
    "local notes",
  );
  assert.equal(readHfManifest(join(target, "owner/model"))?.files.length, 5);
});

test("rejects changed source after preview and keeps both original and destination safe", async () => {
  const { source, target } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "original");
  const state = await prepare(path, { "model.gguf": "original" });
  assert.equal(state.status, "ready");
  writeFileSync(path, "modified");
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /changed/);
  assert.equal(readFileSync(path, "utf8"), "modified");
  assert.equal(existsSync(join(target, "owner/model/model.gguf")), false);
});

test("rejects destination collisions even if created after preview", async () => {
  const { source, target } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "weights");
  const state = await prepare(path, { "model.gguf": "weights" });
  assert.equal(state.status, "ready");
  mkdirSync(join(target, "owner/model"), { recursive: true });
  writeFileSync(join(target, "owner/model/model.gguf"), "existing");
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "failed");
  assert.equal(
    readFileSync(join(target, "owner/model/model.gguf"), "utf8"),
    "existing",
  );
  assert.equal(existsSync(path), true);
});

test("rejects missing shards, mismatched checksums and directory symlinks", async () => {
  const { source } = fixture();
  const first = join(source, "model-00001-of-00002.gguf");
  writeFileSync(first, "first");
  assert.equal(
    (await prepare(first, { "model-00001-of-00002.gguf": "first" })).status,
    "failed",
  );
  const path = join(source, "model.gguf");
  writeFileSync(path, "wrong");
  assert.equal(
    (await prepare(path, { "model.gguf": "right" })).status,
    "failed",
  );
  symlinkSync(path, join(source, "link"));
  const state = await prepare(
    source,
    { "model.gguf": "wrong" },
    { scope: "directory" },
  );
  assert.equal(state.status, "failed");
  assert.match(state.error!, /symbolic links/);
});

test("registers files already at the canonical destination without moving them", async () => {
  const { target } = fixture();
  const source = join(target, "owner/model");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "model.safetensors"), "weights");
  const state = await prepare(
    source,
    { "model.safetensors": "weights" },
    { scope: "directory" },
  );
  assert.equal(state.status, "ready", state.error ?? "");
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(readHfManifest(source)?.files.length, 1);
});

test("updates saved instance paths after importing", async () => {
  const { source, target } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "weights");
  const name = `import-${randomUUID()}`;
  const binary = createPathCatalogEntry({
    kind: "binary",
    name,
    path: "/opt/llama-server",
  });
  createInstance({
    name,
    kind: "llama-server",
    binaryPathRefId: binary.id,
    args: { "--model": path },
    env: {},
    memory: [],
    rpcWorkers: [],
  });
  const state = await prepare(path, { "model.gguf": "weights" });
  assert.equal(state.status, "ready", state.error ?? "");
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(
    getInstance(name)?.args["--model"],
    join(target, "owner/model/model.gguf"),
  );
});

test("rejects incomplete safetensors shards even without an index", async () => {
  const { source } = fixture();
  writeFileSync(join(source, "model-00001-of-00002.safetensors"), "first");
  const state = await prepare(
    source,
    { "model-00001-of-00002.safetensors": "first" },
    { scope: "directory" },
  );
  assert.equal(state.status, "failed");
  assert.match(state.error!, /Missing safetensors shard/);
});

test("updates managed preset paths while preserving neighboring models", async () => {
  const { source, target } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "weights");
  const name = `import-${randomUUID()}`;
  createPreset({ name });
  const preset = readPreset(name)!;
  writePreset(name, {
    content: `[model]\nmodel = ${path}\n\n[other]\nmodel = /archive/other.gguf\n`,
    expectedMtimeMs: preset.mtimeMs,
    force: false,
  });
  const state = await prepare(path, { "model.gguf": "weights" });
  assert.equal(state.status, "ready", state.error ?? "");
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  const imported = readPreset(name)!;
  assert.equal(
    imported.file.entries.find((entry) => entry.name === "model")?.modelPath,
    join(target, "owner/model/model.gguf"),
  );
  assert.equal(
    imported.file.entries.find((entry) => entry.name === "other")?.modelPath,
    "/archive/other.gguf",
  );
});
