import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { ModelImportRequest, ModelLibraryFile } from "@arriero/core";
import { config } from "../config.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import { createInstance, getInstance } from "../instances/repository.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import {
  deleteModelLibraryEntry,
  getLibraryEntry,
  listModelLibraryEntries,
  replaceLibraryEntry,
  upsertModelLibraryEntry,
} from "./model-library.js";
import {
  commitModelImport,
  cancelModelImport,
  getModelImport,
  selectModelImport,
  startModelImport,
} from "./model-import.js";
import { readHfManifest } from "./manifest.js";

const A = "a".repeat(40),
  B = "b".repeat(40);
let source: string, target: string, requests: number;
const offline = {
  token: null,
  fetchImpl: (async () => {
    requests++;
    throw new Error("Network must not be used");
  }) as typeof fetch,
};
function metadata(
  path: string,
  content: string,
  git = false,
): ModelLibraryFile {
  const bytes = Buffer.byteLength(content);
  return {
    path,
    size: bytes,
    oid: git
      ? createHash("sha1").update(`blob ${bytes}\0${content}`).digest("hex")
      : A,
    lfsOid: git ? null : createHash("sha256").update(content).digest("hex"),
  };
}
function save(
  files: ModelLibraryFile[],
  repoId = "owner/offline",
  destDir: string | null = null,
) {
  return upsertModelLibraryEntry({
    repoId,
    revision: A,
    paths: files.map((file) => file.path),
    pinnedFiles: files,
    destDir,
  });
}
async function wait(id: string) {
  for (let i = 0; i < 500; i++) {
    const state = getModelImport(id)!;
    if (!["searching", "checking", "importing"].includes(state.status))
      return state;
    await setTimeout(10);
  }
  throw new Error("Import did not settle");
}
async function prepare(path: string, extra: Partial<ModelImportRequest> = {}) {
  return wait(
    startModelImport(
      {
        sourcePath: path,
        scope: "gguf",
        repo: "",
        revision: "main",
        remotePath: "",
        ...extra,
      },
      offline,
    ).id,
  );
}
beforeEach(() => {
  for (const entry of listModelLibraryEntries())
    deleteModelLibraryEntry(entry.id);
  const root = join(config.dataDir, `offline-import-${randomUUID()}`);
  source = join(root, "archive");
  target = join(root, "models");
  mkdirSync(source, { recursive: true });
  mkdirSync(target);
  saveModelScanSettings({ directory: target, maxDepth: 8 });
  saveHfDownloadSettings({ modelDirectoryId: null, maxEtaHours: null });
  requests = 0;
});

test("offline discovery exposes in-file progress through the public job and can cancel it", async () => {
  const content = "x".repeat(16 * 1024 * 1024);
  const path = join(source, "large.gguf");
  writeFileSync(path, content);
  save([metadata("large.gguf", content)]);
  const job = startModelImport(
    {
      sourcePath: path,
      scope: "gguf",
      repo: "",
      revision: "main",
      remotePath: "",
      searchHf: false,
    },
    offline,
  );
  const deadline = Date.now() + 5000;
  while (
    !getModelImport(job.id)?.verification?.processedBytes &&
    Date.now() < deadline
  ) {
    assert.ok(
      ["searching", "checking"].includes(job.status),
      job.error ?? job.status,
    );
    await setTimeout(1);
  }
  const progress = getModelImport(job.id)?.verification;
  assert.equal(progress?.path, path);
  assert.equal(progress?.totalBytes, content.length);
  assert.ok(
    progress &&
      progress.processedBytes > 0 &&
      progress.processedBytes < content.length,
  );
  cancelModelImport(job.id);
  assert.equal((await wait(job.id)).status, "canceled");
  assert.equal(job.verification, null);
  assert.equal(requests, 0);
  assert.equal(existsSync(path), true);
});

test("auto discovery verifies renamed GGUF and neighbors from library hashes and moves files offline", async () => {
  const custom = join(target, "custom-location");
  const saved = save(
    [
      metadata("quants/model.gguf", "weights"),
      metadata("mmproj.gguf", "projector"),
    ],
    "owner/offline",
    custom,
  );
  writeFileSync(join(source, "renamed.gguf"), "weights");
  writeFileSync(join(source, "mmproj.gguf"), "projector");
  const name = randomUUID();
  const binary = createPathCatalogEntry({
    kind: "binary",
    name,
    path: "/opt/llama-server",
  });
  createInstance({
    name,
    kind: "llama-server",
    binaryPathRefId: binary.id,
    args: { "--model": join(source, "renamed.gguf") },
    env: {},
    memory: [],
    rpcWorkers: [],
  });
  const state = await prepare(join(source, "renamed.gguf"));
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.destDir, custom);
  assert.equal(state.candidates[0]?.origin, "library");
  assert.equal(
    state.candidates[0]?.relatedFiles[0]?.source,
    join(source, "mmproj.gguf"),
  );
  await selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [join(source, "mmproj.gguf")],
    destinations: {},
    keepCompanions: true,
  });
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "succeeded");
  assert.equal(
    readFileSync(join(custom, "quants/model.gguf"), "utf8"),
    "weights",
  );
  assert.equal(readFileSync(join(custom, "mmproj.gguf"), "utf8"), "projector");
  assert.equal(existsSync(join(source, "renamed.gguf")), false);
  assert.equal(existsSync(join(source, "mmproj.gguf")), true);
  assert.equal(
    getInstance(name)?.args["--model"],
    join(custom, "quants/model.gguf"),
  );
  assert.equal(readHfManifest(custom)?.revision, A);
  assert.equal(getLibraryEntry(saved.id).revision, A);
  assert.equal(requests, 0);
});

test("saved snapshot imports a safetensors directory with Git support files and unverified local notes", async () => {
  const contents = {
    "model-00001-of-00002.safetensors": "one",
    "model-00002-of-00002.safetensors": "two",
    "config.json": "{}",
  };
  const saved = save([]);
  replaceLibraryEntry(saved, {
    ...saved,
    snapshot: {
      revision: B,
      files: Object.entries(contents).map(([path, content]) =>
        metadata(path, content, path.endsWith("json")),
      ),
    },
  });
  for (const [path, content] of Object.entries(contents))
    writeFileSync(join(source, path), content);
  writeFileSync(join(source, "notes.txt"), "local notes");
  const state = await prepare(source, { scope: "directory", searchHf: false });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.revision, B);
  assert.equal(
    state.files.find((file) => file.source.endsWith("notes.txt"))?.verified,
    false,
  );
  assert.equal(
    state.files.find((file) => file.source.endsWith("config.json"))?.verified,
    true,
  );
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "succeeded");
  const manifest = readHfManifest(join(target, "owner/offline"));
  assert.equal(manifest?.revision, B);
  assert.equal(manifest?.files.length, 3);
  assert.equal(existsSync(source), false);
  assert.equal(getLibraryEntry(saved.id).revision, A);
  assert.equal(requests, 0);
});

test("GGUF shards require hashes from one saved revision", async () => {
  const one = "model-00001-of-00002.gguf",
    two = "model-00002-of-00002.gguf";
  writeFileSync(join(source, one), "one");
  writeFileSync(join(source, two), "two");
  const saved = save([metadata(one, "one")]);
  replaceLibraryEntry(saved, {
    ...saved,
    snapshot: { revision: B, files: [metadata(two, "two")] },
  });
  const rejected = await prepare(join(source, one), { searchHf: false });
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error!, /sufficient saved hashes/);
  const current = getLibraryEntry(saved.id);
  replaceLibraryEntry(current, {
    ...current,
    pinnedFiles: [metadata(one, "one"), metadata(two, "two")],
  });
  const state = await prepare(join(source, one), { searchHf: false });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.files.length, 2);
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "succeeded");
  assert.equal(readHfManifest(join(target, "owner/offline"))?.files.length, 2);
  assert.equal(requests, 0);
});

test("matching names and sizes do not replace content verification or missing legacy hashes", async () => {
  const saved = save([metadata("model.gguf", "right")]);
  writeFileSync(join(source, "model.gguf"), "wrong");
  let state = await prepare(join(source, "model.gguf"), { searchHf: false });
  assert.equal(state.status, "failed");
  replaceLibraryEntry(saved, { ...saved, pinnedFiles: [] });
  writeFileSync(join(source, "model.gguf"), "right");
  state = await prepare(join(source, "model.gguf"), { searchHf: false });
  assert.equal(state.status, "failed");
  assert.equal(existsSync(join(source, "model.gguf")), true);
  assert.equal(requests, 0);
});

test("duplicate saved repositories require a choice and explicit revisions narrow local search", async () => {
  save([metadata("model.gguf", "weights")], "owner/first");
  save([metadata("model.gguf", "weights")], "owner/second");
  writeFileSync(join(source, "model.gguf"), "weights");
  const state = await prepare(join(source, "model.gguf"), { searchHf: false });
  assert.equal(state.status, "choosing");
  assert.equal(state.candidates.length, 2);
  const revision = await prepare(join(source, "model.gguf"), {
    repo: "owner/first",
    revision: B,
    searchHf: false,
  });
  assert.equal(revision.status, "failed");
  const candidate = state.candidates.find(
    (entry) => entry.repoId === "owner/second",
  )!;
  await selectModelImport({
    id: state.id,
    candidateId: candidate.id,
    companions: [],
    destinations: {},
    keepCompanions: true,
  });
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "succeeded");
  assert.equal(
    readHfManifest(join(target, "owner/second"))?.repoId,
    "owner/second",
  );
  assert.equal(requests, 0);
});
