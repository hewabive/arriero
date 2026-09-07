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
  renameSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { config } from "../config.js";
import { saveModelScanSettings } from "../models/cache-repository.js";
import { saveHfDownloadSettings } from "../settings/downloads.js";
import {
  listModelLibraryEntries,
  deleteModelLibraryEntry,
} from "./model-library.js";
import { readHfManifest } from "./manifest.js";
import {
  startModelImport,
  getModelImport,
  commitModelImport,
  selectModelImport,
  cancelModelImport,
  listModelImports,
} from "./model-import.js";
import type { ModelImportRequest, ModelImportState } from "@arriero/core";

function fixture() {
  for (const entry of listModelLibraryEntries())
    deleteModelLibraryEntry(entry.id);
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
    if (!["searching", "checking", "importing"].includes(state.status))
      return state;
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

function searchHub(
  repositories: Record<string, Record<string, string>>,
  requests: string[] = [],
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    requests.push(parsed.pathname + parsed.search);
    if (parsed.pathname === "/api/models") {
      return new Response(
        JSON.stringify(
          Object.entries(repositories).map(([id, files]) => ({
            id,
            sha: "b".repeat(40),
            siblings: Object.keys(files).map((rfilename) => ({ rfilename })),
          })),
        ),
      );
    }
    const segments = parsed.pathname.split("/");
    const files = repositories[`${segments[3]}/${segments[4]}`];
    assert.ok(files, `Unexpected repository request: ${url}`);
    return mockHub(files)(url);
  }) as typeof fetch;
}

async function discover(
  sourcePath: string,
  repositories: Record<string, Record<string, string>>,
  requests: string[] = [],
  scope: "gguf" | "directory" = "gguf",
) {
  return wait(
    startModelImport(
      { sourcePath, scope, repo: "", revision: "main", remotePath: "" },
      { fetchImpl: searchHub(repositories, requests), token: null },
    ).id,
  );
}

test("automatic discovery finds copies and offers only content-matched neighbors", async () => {
  const { source } = fixture();
  const model = "Novel-Model-Q4_K_M.gguf";
  writeFileSync(join(source, model), "weights");
  writeFileSync(join(source, "mmproj-F16.gguf"), "projector");
  writeFileSync(join(source, "unrelated.gguf"), "unrelated");
  const requests: string[] = [];
  const state = await discover(
    join(source, model),
    {
      "alpha/Novel-Model-GGUF": {
        [model]: "weights",
        "mmproj-F16.gguf": "projector",
      },
      "beta/Novel-Model-GGUF": {
        [model]: "weights",
        "mmproj-F16.gguf": "different",
      },
      "wrong/Novel-Model-GGUF": { [model]: "invalid" },
    },
    requests,
  );
  assert.equal(state.status, "choosing", state.error ?? "");
  assert.equal(state.candidates.length, 2);
  assert.ok(
    requests.some(
      (url) =>
        url.includes("search=Novel-Model") && url.includes("expand=siblings"),
    ),
  );
  const alpha = state.candidates.find((entry) =>
    entry.repoId.startsWith("alpha/"),
  )!;
  const beta = state.candidates.find((entry) =>
    entry.repoId.startsWith("beta/"),
  )!;
  assert.equal(alpha.relatedFiles.length, 1);
  assert.equal(beta.relatedFiles.length, 0);
  assert.equal(alpha.relatedFiles[0]?.kind, "companion");
  await selectModelImport({
    id: state.id,
    candidateId: alpha.id,
    companions: [],
    destinations: {},
    keepCompanions: true,
  });
  assert.equal(state.files.length, 1);
  assert.equal(state.status, "ready");
  assert.ok(listModelImports().some((entry) => entry.id === state.id));
});

test("selected companions are copied independently while the main GGUF moves", async () => {
  const { source, target } = fixture();
  const model = "Novel-Model-Q4_K_M.gguf";
  const projector = join(source, "mmproj-F16.gguf");
  writeFileSync(join(source, model), "weights");
  writeFileSync(projector, "projector");
  const state = await discover(join(source, model), {
    "owner/model": { [model]: "weights", "mmproj-F16.gguf": "projector" },
  });
  assert.equal(state.status, "ready", state.error ?? "");
  await selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [projector],
    destinations: {},
    keepCompanions: true,
  });
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(existsSync(join(source, model)), false);
  assert.equal(readFileSync(projector, "utf8"), "projector");
  writeFileSync(projector, "changed");
  assert.equal(
    readFileSync(join(target, "owner/model/mmproj-F16.gguf"), "utf8"),
    "projector",
  );
  assert.equal(readHfManifest(join(target, "owner/model"))?.files.length, 2);
});

test("a selected neighboring split moves as a complete group", async () => {
  const { source, target } = fixture();
  const model = "Novel-Model-Q4_K_M.gguf";
  const first = "Novel-Model-Q8_0-00001-of-00002.gguf";
  const second = "Novel-Model-Q8_0-00002-of-00002.gguf";
  const files = { [model]: "weights", [first]: "first", [second]: "second" };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(source, name), content);
  const state = await discover(join(source, model), { "owner/model": files });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.files.length, 1);
  assert.equal(state.candidates[0]?.relatedFiles.length, 2);
  await selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [join(source, first)],
    destinations: {},
    keepCompanions: true,
  });
  assert.equal(state.files.length, 3);
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(existsSync(join(source, first)), false);
  assert.equal(existsSync(join(source, second)), false);
  assert.equal(readHfManifest(join(target, "owner/model"))?.files.length, 3);
});

test("duplicate repository paths are offered as choices and cannot be forged", async () => {
  const { source, target } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "weights");
  const state = await prepare(path, {
    "model.gguf": "weights",
    "alternate/renamed.gguf": "weights",
  });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(
    state.files[0]?.destination,
    join(target, "owner/model/model.gguf"),
  );
  assert.equal(state.files[0]?.alternatives?.length, 2);
  await assert.rejects(
    selectModelImport({
      id: state.id,
      candidateId: state.selectedCandidateId!,
      companions: [],
      destinations: { [path]: "/unverified/model.gguf" },
      keepCompanions: true,
    }),
    /not verified/,
  );
  await selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [],
    destinations: {
      [path]: join(target, "owner/model/alternate/renamed.gguf"),
    },
    keepCompanions: true,
  });
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "succeeded", result.error ?? "");
  assert.equal(
    readHfManifest(join(target, "owner/model"))?.files[0]?.path,
    "alternate/renamed.gguf",
  );
});

test("automatic search uses the directory name for safetensors", async () => {
  const { source } = fixture();
  const folder = join(source, "Novel-Model");
  mkdirSync(folder);
  writeFileSync(join(folder, "model.safetensors"), "weights");
  writeFileSync(join(folder, "config.json"), "{}");
  const requests: string[] = [];
  const state = await discover(
    folder,
    {
      "owner/Novel-Model": {
        "model.safetensors": "weights",
        "config.json": "{}",
      },
    },
    requests,
    "directory",
  );
  assert.equal(state.status, "ready", state.error ?? "");
  assert.ok(requests.some((url) => url.includes("search=Novel-Model")));
  assert.equal(state.files.length, 2);
});

test("search can be canceled without changing local files", async () => {
  const { source } = fixture();
  const path = join(source, "Novel-Model.gguf");
  writeFileSync(path, "weights");
  const state = startModelImport(
    {
      sourcePath: path,
      scope: "gguf",
      repo: "",
      revision: "main",
      remotePath: "",
    },
    {
      fetchImpl: searchHub({ "owner/model": { "model.gguf": "weights" } }),
      token: null,
    },
  );
  cancelModelImport(state.id);
  assert.equal((await wait(state.id)).status, "canceled");
  assert.equal(readFileSync(path, "utf8"), "weights");
});

test("cached content hashes are invalidated when a local file changes", async () => {
  const { source } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "first");
  assert.equal(
    (await prepare(path, { "model.gguf": "first" })).status,
    "ready",
  );
  writeFileSync(path, "other");
  const state = await prepare(path, { "model.gguf": "first" });
  assert.equal(state.status, "failed");
  assert.match(state.error!, /No matching content/);
});

test("neighbor discovery verifies support files and leaves unrelated weights alone", async () => {
  const { source, target } = fixture();
  const files = {
    "Novel-Model.gguf": "weights",
    "tokenizer.json": "tokenizer",
    "config.json": "local config",
    "model.safetensors": "other weights",
    ".hidden": "hidden",
  };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(source, name), content);
  const state = await discover(join(source, "Novel-Model.gguf"), {
    "owner/model": { ...files, "config.json": "remote config" },
  });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.deepEqual(
    state.candidates[0]?.relatedFiles.map((file) => file.source),
    [join(source, "tokenizer.json")],
  );
  await selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [join(source, "tokenizer.json")],
    destinations: {},
    keepCompanions: true,
  });
  commitModelImport(state.id);
  assert.equal((await wait(state.id)).status, "succeeded");
  assert.equal(
    readFileSync(join(target, "owner/model/tokenizer.json"), "utf8"),
    "tokenizer",
  );
  assert.equal(
    readFileSync(join(source, "tokenizer.json"), "utf8"),
    "tokenizer",
  );
  assert.equal(existsSync(join(source, "model.safetensors")), true);
});

test("canceling a selection check cannot restore a ready preview", async () => {
  const { source } = fixture();
  const path = join(source, "model.gguf");
  writeFileSync(path, "weights");
  const state = await prepare(path, { "model.gguf": "weights" });
  const selection = selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [],
    destinations: {},
    keepCompanions: true,
  });
  cancelModelImport(state.id);
  await selection;
  assert.equal(state.status, "canceled");
  assert.throws(() => commitModelImport(state.id), /unavailable/);
});

for (const selected of ["Novel-Q4.gguf", "Q8/Novel-Q8-00002-of-00002.gguf"]) {
  test(`mixed repository layout is discoverable starting from ${selected}`, async () => {
    const { source, target } = fixture();
    const files = {
      "Novel-Q4.gguf": "small weights",
      "Q8/Novel-Q8-00001-of-00002.gguf": "first shard",
      "Q8/Novel-Q8-00002-of-00002.gguf": "second shard",
      "mmproj-F16.gguf": "projector",
      "MTP/mtp-Novel.gguf": "draft",
      "projectors/vision/f16/mmproj-deep.gguf": "deep projector",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), content);
    }
    writeFileSync(join(source, "local-notes.txt"), "keep me");
    const state = await prepare(join(source, selected), files);
    assert.equal(state.status, "ready", state.error ?? "");
    const candidate = state.candidates[0]!;
    assert.equal(candidate.files.length + candidate.relatedFiles.length, 6);
    assert.ok(
      candidate.relatedFiles.some((file) =>
        file.relativePath.includes("mmproj"),
      ),
    );
    await selectModelImport({
      id: state.id,
      candidateId: candidate.id,
      companions: candidate.relatedFiles.map((file) => file.source),
      destinations: {},
      keepCompanions: true,
    });
    commitModelImport(state.id);
    const result = await wait(state.id);
    assert.equal(result.status, "succeeded", result.error ?? "");
    assert.equal(readHfManifest(join(target, "owner/model"))?.files.length, 6);
    for (const [path, content] of Object.entries(files)) {
      assert.equal(
        readFileSync(join(target, "owner/model", path), "utf8"),
        content,
      );
      assert.equal(existsSync(join(source, path)), /mmproj|mtp-/.test(path));
    }
    assert.equal(
      readFileSync(join(source, "local-notes.txt"), "utf8"),
      "keep me",
    );
  });
}

test("neighbor projection rejects changed content, symlinks and incomplete groups", async () => {
  const { source } = fixture();
  const files = {
    "Novel.gguf": "main",
    "Q8/Novel-00001-of-00002.gguf": "first",
    "Q8/Novel-00002-of-00002.gguf": "second",
    "MTP/mtp-Novel.gguf": "remote",
    "links/mmproj.gguf": "projector",
  };
  mkdirSync(join(source, "Q8"));
  mkdirSync(join(source, "MTP"));
  const outside = join(dirname(source), ".external");
  mkdirSync(outside);
  writeFileSync(join(outside, "mmproj.gguf"), "projector");
  symlinkSync(outside, join(source, "links"));
  writeFileSync(join(source, "Novel.gguf"), "main");
  writeFileSync(join(source, "Q8/Novel-00001-of-00002.gguf"), "first");
  writeFileSync(join(source, "MTP/mtp-Novel.gguf"), "edited");
  const state = await prepare(join(source, "Novel.gguf"), files);
  assert.equal(state.status, "ready", state.error ?? "");
  assert.equal(state.candidates[0]?.relatedFiles.length, 0);
});

test("shard matching chooses one complete remote group and never mixes directories", async () => {
  const { source } = fixture();
  const first = "Novel-00001-of-00002.gguf";
  const second = "Novel-00002-of-00002.gguf";
  writeFileSync(join(source, first), "first");
  writeFileSync(join(source, second), "second");
  const state = await prepare(join(source, first), {
    [`A/${first}`]: "first",
    [`A/${second}`]: "wrong!",
    [`B/${first}`]: "wrong",
    [`B/${second}`]: "second",
    [`C/${first}`]: "first",
    [`C/${second}`]: "second",
  });
  assert.equal(state.status, "ready", state.error ?? "");
  assert.ok(state.files.every((file) => file.destination.includes("/C/")));
  const failed = await prepare(join(source, first), {
    [`A/${first}`]: "first",
    [`A/${second}`]: "wrong!",
    [`B/${first}`]: "wrong",
    [`B/${second}`]: "second",
  });
  assert.equal(failed.status, "failed");
});

test("import rechecks neighboring directories after selection", async () => {
  const { source, target } = fixture();
  mkdirSync(join(source, "MTP"));
  writeFileSync(join(source, "Novel.gguf"), "main");
  writeFileSync(join(source, "MTP/mtp-Novel.gguf"), "draft");
  const state = await prepare(join(source, "Novel.gguf"), {
    "Novel.gguf": "main",
    "MTP/mtp-Novel.gguf": "draft",
  });
  await selectModelImport({
    id: state.id,
    candidateId: state.selectedCandidateId!,
    companions: [join(source, "MTP/mtp-Novel.gguf")],
    destinations: {},
    keepCompanions: false,
  });
  renameSync(join(source, "MTP"), join(source, "relocated"));
  symlinkSync(join(source, "relocated"), join(source, "MTP"));
  commitModelImport(state.id);
  const result = await wait(state.id);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /symbolic link/);
  assert.equal(existsSync(join(target, "owner/model/Novel.gguf")), false);
  assert.equal(
    readFileSync(join(source, "relocated/mtp-Novel.gguf"), "utf8"),
    "draft",
  );
});
