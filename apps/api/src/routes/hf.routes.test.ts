import { parseHfRepoInput, type HfDownloadSettings } from "@arriero/core";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { lockModelImport } from "../hf/import-lock.js";
import { setHfToken } from "../hf/token.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import { registerHfRoutes } from "./hf.routes.js";

function appWithRoutes() {
  const app = new Hono();
  registerHfRoutes(app);
  return app;
}

beforeEach(() => {
  setHfToken(null);
});

test("token status starts unconfigured and never echoes the token", async () => {
  const app = appWithRoutes();
  const before = await app.request("/api/hf/token");
  assert.deepEqual(await before.json(), { data: { tokenConfigured: false } });

  const updated = await app.request("/api/hf/token", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "hf_super_secret_value" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.text();
  assert.ok(!updatedBody.includes("hf_super_secret_value"));
  assert.deepEqual(JSON.parse(updatedBody), {
    data: { tokenConfigured: true },
  });

  const cleared = await app.request("/api/hf/token", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: null }),
  });
  assert.deepEqual(await cleared.json(), { data: { tokenConfigured: false } });
});

test("token update rejects a malformed body", async () => {
  const response = await appWithRoutes().request("/api/hf/token", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: 42 }),
  });
  assert.equal(response.status, 400);
});

function patchDownloadSettings(app: Hono, body: unknown) {
  return app.request("/api/hf/download-settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadDownloadSettings(app: Hono) {
  const loaded = await app.request("/api/hf/download-settings");
  return ((await loaded.json()) as { data: HfDownloadSettings }).data;
}

test("download settings persist a selected model directory", async () => {
  const modelDirectory = createPathCatalogEntry({
    kind: "models-dir",
    name: "HF downloads",
    path: "/mnt/hf-downloads",
  });
  const app = appWithRoutes();
  const updated = await patchDownloadSettings(app, {
    modelDirectoryId: modelDirectory.id,
    maxEtaHours: 12,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await loadDownloadSettings(app), {
    modelDirectoryId: modelDirectory.id,
    maxEtaHours: 12,
  });
});

test("a partial download-settings update keeps the other field", async () => {
  const modelDirectory = createPathCatalogEntry({
    kind: "models-dir",
    name: "HF partial downloads",
    path: "/mnt/hf-partial-downloads",
  });
  const app = appWithRoutes();
  await patchDownloadSettings(app, {
    modelDirectoryId: modelDirectory.id,
    maxEtaHours: 6,
  });

  const eta = await patchDownloadSettings(app, { maxEtaHours: null });
  assert.equal(eta.status, 200);
  assert.deepEqual(await eta.json(), {
    data: { modelDirectoryId: modelDirectory.id, maxEtaHours: null },
  });

  const directory = await patchDownloadSettings(app, {
    modelDirectoryId: null,
  });
  assert.equal(directory.status, 200);
  assert.deepEqual(await loadDownloadSettings(app), {
    modelDirectoryId: null,
    maxEtaHours: null,
  });

  const unchanged = await patchDownloadSettings(app, {});
  assert.deepEqual(await unchanged.json(), {
    data: { modelDirectoryId: null, maxEtaHours: null },
  });
});

test("download settings reject a path catalog entry of the wrong kind", async () => {
  const binary = createPathCatalogEntry({
    kind: "binary",
    name: "HF settings wrong-kind binary",
    path: "/opt/bin/llama-server",
  });
  const response = await patchDownloadSettings(appWithRoutes(), {
    modelDirectoryId: binary.id,
  });
  assert.equal(response.status, 400);
});

test("download settings reject an out-of-range max ETA", async () => {
  const response = await patchDownloadSettings(appWithRoutes(), {
    maxEtaHours: 0,
  });
  assert.equal(response.status, 400);
});

test("browse rejects unparsable repo input", async () => {
  const app = appWithRoutes();
  for (const repo of ["", "not a repo", "https://example.com/owner/repo"]) {
    const response = await app.request(
      `/api/hf/browse?repo=${encodeURIComponent(repo)}`,
    );
    assert.equal(response.status, 400);
  }
});

test("library snapshot rejects an invalid query", async () => {
  const app = appWithRoutes();
  for (const query of [
    "",
    "repo=owner%2Frepo",
    "revision=main",
    "repo=not%20a%20repo&revision=main",
    "repo=owner%2Frepo&revision=",
  ]) {
    const response = await app.request(`/api/hf/snapshot?${query}`);
    assert.equal(response.status, 400, query);
  }
});

function hubTree(requests: string[], status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (status !== 200)
      return new Response(JSON.stringify({ error: "missing" }), { status });
    if (url.pathname.includes("/revision/"))
      return Response.json({ sha: "c".repeat(40) });
    return Response.json([
      { type: "directory", path: "quants", oid: "d".repeat(40) },
      {
        type: "file",
        path: "quants/model-Q4_K_M.gguf",
        size: 120,
        oid: "e".repeat(40),
        lfs: { oid: "f".repeat(64), size: 4096 },
      },
      { type: "file", path: "README.md", size: 12, oid: "a".repeat(40) },
    ]);
  }) as typeof fetch;
}

test("library snapshot lists a commit tree without resolving the revision", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", hubTree(requests));
  const sha = "b".repeat(40);
  const response = await appWithRoutes().request(
    `/api/hf/snapshot?repo=owner%2Frepo&revision=${sha}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: {
      revision: sha,
      files: [
        {
          path: "quants/model-Q4_K_M.gguf",
          size: 4096,
          oid: "e".repeat(40),
          lfsOid: "f".repeat(64),
        },
        { path: "README.md", size: 12, oid: "a".repeat(40), lfsOid: null },
      ],
    },
  });
  assert.deepEqual(requests, [`/api/models/owner/repo/tree/${sha}`]);
});

test("library snapshot pins a branch to its current commit", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", hubTree(requests));
  const response = await appWithRoutes().request(
    "/api/hf/snapshot?repo=owner%2Frepo&revision=main",
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data: { revision: string } };
  assert.equal(payload.data.revision, "c".repeat(40));
  assert.deepEqual(requests, [
    "/api/models/owner/repo/revision/main",
    `/api/models/owner/repo/tree/${"c".repeat(40)}`,
  ]);
});

test("library snapshot maps Hub errors to their HTTP status", async (t) => {
  t.mock.method(globalThis, "fetch", hubTree([], 404));
  const response = await appWithRoutes().request(
    `/api/hf/snapshot?repo=owner%2Frepo&revision=${"b".repeat(40)}`,
  );
  assert.equal(response.status, 404);
});

test("download delete rejects unknown dirs and bad bodies", async () => {
  const app = appWithRoutes();
  const bad = await app.request("/api/hf/downloads/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);

  const missing = await app.request("/api/hf/downloads/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: "/nonexistent/hf/download" }),
  });
  assert.equal(missing.status, 404);
});

test("integrity check rejects unknown dirs and bad bodies", async () => {
  const app = appWithRoutes();
  for (const path of [
    "/api/hf/downloads/integrity",
    "/api/hf/downloads/integrity/jobs",
  ]) {
    const bad = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    const missing = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "/nonexistent/hf/download" }),
    });
    assert.equal(missing.status, 404);
  }
  const empty = await app.request("/api/hf/downloads/integrity/jobs");
  assert.equal(empty.status, 400);
  const absent = await app.request(
    "/api/hf/downloads/integrity/jobs?dir=/nonexistent",
  );
  assert.deepEqual(await absent.json(), { data: null });
});

test("integrity, verification and delete answer 409 during a model import", async () => {
  const app = appWithRoutes();
  const dir = "/nonexistent/hf/importing";
  const release = lockModelImport([dir]);
  try {
    for (const [path, body] of [
      ["/api/hf/downloads/integrity", { dir }],
      ["/api/hf/downloads/integrity/jobs", { dir }],
      ["/api/hf/downloads/delete", { dir, verifyUpstream: true }],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 409, path);
    }
  } finally {
    release();
  }
});

test("job endpoints return 404 when nothing is running", async () => {
  const app = appWithRoutes();
  const job = await app.request("/api/hf/jobs/owner/repo");
  assert.equal(job.status, 404);
  const cancel = await app.request("/api/hf/jobs/owner/repo/cancel", {
    method: "POST",
  });
  assert.equal(cancel.status, 404);
});

test("parseHfRepoInput accepts ids and HuggingFace URLs", () => {
  assert.deepEqual(parseHfRepoInput("owner/repo"), {
    repoId: "owner/repo",
    revision: null,
  });
  assert.deepEqual(parseHfRepoInput("https://huggingface.co/owner/repo"), {
    repoId: "owner/repo",
    revision: null,
  });
  assert.deepEqual(
    parseHfRepoInput("https://huggingface.co/owner/repo/tree/dev"),
    { repoId: "owner/repo", revision: "dev" },
  );
  assert.deepEqual(parseHfRepoInput("hf.co/owner/repo/blob/main/model.gguf"), {
    repoId: "owner/repo",
    revision: "main",
  });
  assert.deepEqual(
    parseHfRepoInput(
      "https://huggingface.co/owner/repo?not-for-all-audiences=true",
    ),
    { repoId: "owner/repo", revision: null },
  );
  assert.equal(parseHfRepoInput("plainword"), null);
  assert.equal(parseHfRepoInput("https://example.com/owner/repo"), null);
  assert.equal(
    parseHfRepoInput("https://huggingface.co/datasets/owner/repo"),
    null,
  );
});
