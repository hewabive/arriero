import { Hono } from "hono";
import assert from "node:assert/strict";
import test from "node:test";

import { registerBenchmarkRoutes } from "./benchmark.routes.js";

const app = new Hono();
registerBenchmarkRoutes(app);

function jsonRequest(method: string, body: unknown) {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

test("prompt CRUD over http", async () => {
  const invalid = await app.request(
    "/api/benchmark/prompts",
    jsonRequest("POST", { title: "broken" }),
  );
  assert.equal(invalid.status, 400);

  const created = await app.request(
    "/api/benchmark/prompts",
    jsonRequest("POST", {
      title: "Route test prompt",
      topic: "code",
      language: "en",
      prefillClass: "short",
      maxTokens: 64,
      messages: [{ role: "user", content: "say hi" }],
    }),
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    data: { id: string; title: string };
  };

  const listed = await app.request("/api/benchmark/prompts");
  assert.equal(listed.status, 200);
  const listedBody = (await listed.json()) as {
    data: Array<{ id: string; source: string }>;
  };
  const entry = listedBody.data.find(
    (prompt) => prompt.id === createdBody.data.id,
  );
  assert.equal(entry?.source, "custom");

  const meta = await app.request("/api/benchmark/prompts?meta=true");
  assert.equal(meta.status, 200);
  const metaBody = (await meta.json()) as {
    data: Array<Record<string, unknown>>;
  };
  const metaEntry = metaBody.data.find(
    (prompt) => prompt.id === createdBody.data.id,
  );
  assert.ok(metaEntry);
  assert.equal("messages" in metaEntry, false);
  assert.equal(metaEntry.topic, "code");
  assert.equal(metaEntry.maxTokens, 64);

  const updated = await app.request(
    `/api/benchmark/prompts/${createdBody.data.id}`,
    jsonRequest("PUT", { title: "Renamed route prompt" }),
  );
  assert.equal(updated.status, 200);
  const updatedBody = (await updated.json()) as { data: { title: string } };
  assert.equal(updatedBody.data.title, "Renamed route prompt");

  const duplicate = await app.request(
    "/api/benchmark/prompts",
    jsonRequest("POST", {
      id: createdBody.data.id,
      title: "Duplicate",
      topic: "code",
      language: "en",
      prefillClass: "short",
      maxTokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(duplicate.status, 409);

  const deleted = await app.request(
    `/api/benchmark/prompts/${createdBody.data.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 200);
  const deletedAgain = await app.request(
    `/api/benchmark/prompts/${createdBody.data.id}`,
    { method: "DELETE" },
  );
  assert.equal(deletedAgain.status, 404);
});

test("run endpoints validate input and report missing entities", async () => {
  const invalid = await app.request(
    "/api/benchmark/runs",
    jsonRequest("POST", { mode: "parallel" }),
  );
  assert.equal(invalid.status, 400);

  const prompt = await app.request(
    "/api/benchmark/prompts",
    jsonRequest("POST", {
      title: "Run route prompt",
      topic: "code",
      language: "en",
      prefillClass: "short",
      maxTokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  const promptBody = (await prompt.json()) as { data: { id: string } };

  const missingInstance = await app.request(
    "/api/benchmark/runs",
    jsonRequest("POST", {
      target: { kind: "instance", instanceName: "missing-instance" },
      mode: "sequential",
      composition: [{ promptId: promptBody.data.id, count: 1 }],
    }),
  );
  assert.equal(missingInstance.status, 404);

  const list = await app.request("/api/benchmark/runs");
  assert.equal(list.status, 200);
  assert.equal(
    (await app.request("/api/benchmark/runs?status=succeeded&label=x")).status,
    200,
  );
  assert.equal(
    (await app.request("/api/benchmark/runs?status=bogus")).status,
    400,
  );

  assert.equal((await app.request("/api/benchmark/runs/unknown")).status, 404);
  assert.equal(
    (await app.request("/api/benchmark/runs/unknown?waitMs=nope")).status,
    400,
  );
  assert.equal(
    (await app.request("/api/benchmark/runs/unknown/result")).status,
    404,
  );
  assert.equal(
    (await app.request("/api/benchmark/runs/unknown/events")).status,
    404,
  );
  assert.equal(
    (
      await app.request("/api/benchmark/runs/unknown/cancel", {
        method: "POST",
      })
    ).status,
    404,
  );
  assert.equal(
    (await app.request("/api/benchmark/runs/unknown", { method: "DELETE" }))
      .status,
    404,
  );

  await app.request(`/api/benchmark/prompts/${promptBody.data.id}`, {
    method: "DELETE",
  });
});
