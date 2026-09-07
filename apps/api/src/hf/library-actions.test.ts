import { createInstance, getInstance } from "../instances/repository.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { config } from "../config.js";
import { resetAllConfigStores } from "../config-store/registry.js";
import {
  createLibraryEntry,
  actOnLibraryEntry,
  expandLibrarySelection,
} from "./library-actions.js";
import { checkLibraryEntry, getLibraryCheck } from "./library-checks.js";
import {
  getLibraryEntry,
  evaluateModelLibraryEntry,
  listModelLibraryEntries,
  libraryDestDir,
  MODEL_LIBRARY_FILE,
  upsertModelLibraryEntry,
} from "./model-library.js";
import {
  getHfDownloadQueueState,
  resetHfDownloadQueueForTests,
} from "./download-queue.js";
import { deleteHfDownload, invalidateHfDownloadsCache } from "./downloads.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import { ModelLibraryEntrySchema } from "@arriero/core";

const A = "a".repeat(40),
  B = "b".repeat(40);
const versions: Record<string, Record<string, string>> = {
  [A]: {
    "model.gguf": "weights A",
    "broken.gguf": "broken A",
    "README.md": "old",
    "removed.txt": "old",
  },
  [B]: {
    "model.gguf": "weights B",
    "broken.gguf": "fixed B",
    "README.md": "new",
    "new.gguf": "new weights",
  },
};
let head = A;
let requests: string[] = [];
const metadata = (files: Record<string, string>) =>
  Object.entries(files).map(([path, content]) => ({
    type: "file",
    path,
    size: Buffer.byteLength(content),
    oid: "c".repeat(40),
    lfs: {
      oid: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    },
  }));
const fetchImpl = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = decodeURIComponent(String(input));
  requests.push(url);
  if (url.includes("/revision/"))
    return new Response(
      JSON.stringify({
        sha: url.endsWith("/main") ? head : url.split("/").at(-1),
      }),
    );
  const revision =
    url.match(/\/(?:tree|paths-info|resolve)\/([^/?]+)/)?.[1] ?? A;
  const files = versions[revision]!;
  if (url.includes("/tree/"))
    return new Response(JSON.stringify(metadata(files)));
  if (url.includes("/paths-info/")) {
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify(
        metadata(files).filter((file) => body.paths.includes(file.path)),
      ),
    );
  }
  const path = url.split(`/resolve/${revision}/`)[1]!;
  const content = Buffer.from(files[path]!);
  const range = new Headers(init?.headers)
    .get("range")
    ?.match(/bytes=(\d+)-(\d*)/);
  const start = Number(range?.[1] ?? 0),
    end = range?.[2] ? Number(range[2]) : content.length - 1;
  return new Response(content.subarray(start, end + 1), {
    status: range ? 206 : 200,
    headers: {
      "content-length": String(end - start + 1),
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${content.length}` }
        : {}),
    },
  });
}) as typeof fetch;
const options = { fetchImpl, token: null };
beforeEach(() => {
  rmSync(MODEL_LIBRARY_FILE, { force: true });
  resetAllConfigStores();
  resetHfDownloadQueueForTests();
  head = A;
  requests = [];
  saveModelScanSettings({ directory: config.modelsDir, maxDepth: 8 });
  saveHfDownloadSettings({ modelDirectoryId: null, maxEtaHours: null });
});

async function entry(paths: string[] = []) {
  return createLibraryEntry(
    { repoId: "owner/library", revision: "main", paths, destDir: null },
    options,
  );
}

test("watch-only entries compare the whole repository without downloading or dirtying configuration", async () => {
  const saved = await entry();
  const before = readFileSync(MODEL_LIBRARY_FILE, "utf8");
  head = B;
  const check = await checkLibraryEntry(saved, options);
  assert.equal(check.status, "changed");
  assert.ok(
    check.changes.some(
      (file) => file.path === "broken.gguf" && file.kind === "updated",
    ),
  );
  assert.ok(
    check.changes.some(
      (file) => file.path === "new.gguf" && file.kind === "added",
    ),
  );
  assert.ok(
    check.changes.some(
      (file) => file.path === "removed.txt" && file.kind === "deleted",
    ),
  );
  assert.equal(evaluateModelLibraryEntry(saved, []).state, "watching");
  assert.equal(readFileSync(MODEL_LIBRARY_FILE, "utf8"), before);
  assert.ok(requests.every((url) => !url.includes("/resolve/")));
});

test("reviewing changes and updating the installation pin are independent", async () => {
  const saved = await entry(["model.gguf"]);
  head = B;
  await actOnLibraryEntry(saved.id, { action: "check" }, options);
  await actOnLibraryEntry(
    saved.id,
    { action: "acknowledge", revision: B },
    options,
  );
  assert.equal(getLibraryEntry(saved.id).revision, A);
  assert.equal(getLibraryEntry(saved.id).snapshot?.revision, B);
  const retained = getLibraryCheck(getLibraryEntry(saved.id));
  assert.equal(retained.status, "current");
  assert.equal(retained.snapshot?.revision, B);
  assert.deepEqual(retained.changes, []);
  await actOnLibraryEntry(saved.id, { action: "check" }, options);
  await actOnLibraryEntry(
    saved.id,
    { action: "pin", revision: B, paths: ["model.gguf", "new.gguf"] },
    options,
  );
  assert.equal(getLibraryEntry(saved.id).revision, B);
  assert.equal(getLibraryEntry(saved.id).pinnedFiles.length, 2);
});

test("download capture cannot repin or merge a different revision", async () => {
  const saved = await entry(["model.gguf"]);
  upsertModelLibraryEntry({
    repoId: saved.repoId,
    revision: B,
    paths: ["new.gguf"],
    destDir: null,
  });
  assert.equal(getLibraryEntry(saved.id).revision, A);
  assert.deepEqual(getLibraryEntry(saved.id).paths, ["model.gguf"]);
});

test("truncated and inaccessible trees never become accepted snapshots", async () => {
  const saved = await entry();
  head = B;
  const truncated = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const response = await fetchImpl(input, init);
    if (String(input).includes("/tree/"))
      response.headers.set("link", `<${input}>; rel="next"`);
    return response;
  }) as typeof fetch;
  const check = await checkLibraryEntry(saved, {
    fetchImpl: truncated,
    token: null,
  });
  assert.equal(check.status, "error");
  assert.equal(check.snapshot, null);
  assert.deepEqual(check.changes, []);
  await assert.rejects(
    actOnLibraryEntry(
      saved.id,
      { action: "acknowledge", revision: B },
      options,
    ),
    /Check the repository again/,
  );
  assert.equal(getLibraryEntry(saved.id).snapshot?.revision, A);
});

test("file selection expands complete GGUF and safetensors sets and rejects forged paths", () => {
  const names = [
    "q8/m-00001-of-00002.gguf",
    "q8/m-00002-of-00002.gguf",
    "model/model-00001-of-00002.safetensors",
    "model/model-00002-of-00002.safetensors",
    "model/config.json",
  ];
  const snapshot = {
    revision: A,
    files: names.map((path) => ({ path, size: 1, oid: A, lfsOid: null })),
  };
  assert.equal(expandLibrarySelection(snapshot, [names[0]!]).length, 2);
  assert.equal(expandLibrarySelection(snapshot, [names[2]!]).length, 3);
  assert.throws(() => expandLibrarySelection(snapshot, ["../evil.gguf"]));
  assert.throws(
    () =>
      expandLibrarySelection(
        { ...snapshot, files: snapshot.files.slice(0, 1) },
        [names[0]!],
      ),
    /incomplete/,
  );
});

test("legacy configuration remains readable and empty selections become watch-only", async () => {
  const legacy = ModelLibraryEntrySchema.parse({
    id: "legacy",
    repoId: "owner/legacy",
    revision: A,
    paths: ["model.gguf"],
    destDir: null,
  });
  assert.equal(legacy.snapshot, null);
  assert.equal(legacy.watchRevision, "main");
  const saved = await entry(["model.gguf"]);
  await actOnLibraryEntry(
    saved.id,
    { action: "select", revision: A, paths: [] },
    options,
  );
  assert.equal(
    evaluateModelLibraryEntry(getLibraryEntry(saved.id), []).state,
    "watching",
  );
  assert.equal(getLibraryEntry(saved.id).snapshot?.revision, A);
});

test("selected files survive deleting weights and restore to the same portable location", async () => {
  const saved = await entry(["model.gguf", "broken.gguf"]);
  const before = readFileSync(MODEL_LIBRARY_FILE, "utf8");
  assert.ok(!before.includes(config.modelsDir));
  for (let pass = 0; pass < 2; pass++) {
    await actOnLibraryEntry(
      saved.id,
      { action: "download", revision: A, paths: ["model.gguf"] },
      options,
    );
    for (let attempt = 0; attempt < 500; attempt++) {
      const state = getHfDownloadQueueState();
      if (!state.active && !state.queued.length) break;
      await setTimeout(10);
    }
    const state = getHfDownloadQueueState();
    assert.equal(
      state.history[0]?.status,
      "succeeded",
      state.history[0]?.error ?? "",
    );
    assert.equal(
      readFileSync(join(config.modelsDir, "owner/library/model.gguf"), "utf8"),
      "weights A",
    );
    assert.equal(readFileSync(MODEL_LIBRARY_FILE, "utf8"), before);
    invalidateHfDownloadsCache();
    deleteHfDownload(join(config.modelsDir, "owner/library"));
    resetAllConfigStores();
    assert.equal(listModelLibraryEntries()[0]?.id, saved.id);
  }
});

test("cloned portable configuration resolves library files and instance paths under the new model root", async () => {
  const saved = await entry(["model.gguf"]);
  const name = `library-${randomUUID()}`;
  const binary = createPathCatalogEntry({
    kind: "binary",
    name,
    path: "/opt/llama-server",
  });
  createInstance({
    name,
    kind: "llama-server",
    binaryPathRefId: binary.id,
    args: { "--model": join(config.modelsDir, "owner/library/model.gguf") },
    env: {},
    memory: [],
    rpcWorkers: [],
  });
  const originalRoot = config.modelsDir;
  try {
    config.modelsDir = join(config.runtimeDir, `rented-${randomUUID()}`);
    resetAllConfigStores();
    const restored = getLibraryEntry(saved.id);
    assert.equal(
      libraryDestDir(restored),
      join(config.modelsDir, "owner/library"),
    );
    assert.equal(
      getInstance(name)?.args["--model"],
      join(libraryDestDir(restored), "model.gguf"),
    );
    await actOnLibraryEntry(
      restored.id,
      { action: "download", revision: A, paths: ["model.gguf"] },
      options,
    );
    for (let attempt = 0; attempt < 500; attempt++) {
      const state = getHfDownloadQueueState();
      if (!state.active && !state.queued.length) break;
      await setTimeout(10);
    }
    assert.equal(getHfDownloadQueueState().history[0]?.status, "succeeded");
    assert.equal(
      readFileSync(String(getInstance(name)?.args["--model"]), "utf8"),
      "weights A",
    );
  } finally {
    config.modelsDir = originalRoot;
    resetAllConfigStores();
  }
});
