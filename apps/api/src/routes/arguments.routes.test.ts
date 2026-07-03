import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import { registerArgumentRoutes } from "./arguments.routes.js";

function appWithRoutes() {
  const app = new Hono();
  registerArgumentRoutes(app);
  return app;
}

test("argument catalog rejects an unknown instance kind", async () => {
  const response = await appWithRoutes().request(
    "/api/llama-args?kind=unknown-engine",
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.match(payload.error, /unknown instance kind/);
});

test("argument catalog rejects kinds without a help parser", async () => {
  const response = await appWithRoutes().request(
    "/api/llama-args?kind=rpc-worker",
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.match(payload.error, /no argument catalog for instance kind/);
});

test("argument catalog defaults to the llama-server parser without a kind", async () => {
  const response = await appWithRoutes().request(
    "/api/llama-args?binaryPath=/nonexistent/llama-server",
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: string };
  assert.doesNotMatch(payload.error, /instance kind/);
});
