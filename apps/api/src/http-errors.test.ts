import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import {
  ConfigFileError,
  ConfigWriteConflictError,
} from "./config-store/errors.js";
import { registerErrorHandler } from "./http-errors.js";

function makeApp() {
  const app = new Hono();
  registerErrorHandler(app);
  app.get("/config-error", () => {
    throw new ConfigFileError("/data/config/settings.json", "schema", "boom");
  });
  app.post("/echo", async (c) => c.json({ data: await c.req.json() }));
  app.get("/boom", () => {
    throw new Error("nope");
  });
  app.put("/conflict", () => {
    throw new ConfigWriteConflictError("/data/config/resources.json");
  });
  return app;
}

test("write conflicts map to 409", async () => {
  const response = await makeApp().request("/conflict", { method: "PUT" });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /changed on disk since it was loaded/);
});

test("config file errors surface the failing file", async () => {
  const response = await makeApp().request("/config-error");
  assert.equal(response.status, 503);
  const body = (await response.json()) as {
    error: { message: string; configFile: string };
  };
  assert.equal(body.error.configFile, "/data/config/settings.json");
  assert.match(body.error.message, /Invalid config in/);
});

test("malformed request bodies return 400, not 500", async () => {
  const response = await makeApp().request("/echo", {
    method: "POST",
    body: "{ nope",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "invalid JSON body");
});

test("unexpected errors return a generic 500", async () => {
  const response = await makeApp().request("/boom");
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "internal error");
});
