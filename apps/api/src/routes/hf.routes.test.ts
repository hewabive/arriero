import { parseHfRepoInput } from "@arriero/core";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Hono } from "hono";

import { setHfToken } from "../hf/token.js";
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

test("browse rejects unparsable repo input", async () => {
  const app = appWithRoutes();
  for (const repo of ["", "not a repo", "https://example.com/owner/repo"]) {
    const response = await app.request(
      `/api/hf/browse?repo=${encodeURIComponent(repo)}`,
    );
    assert.equal(response.status, 400);
  }
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
