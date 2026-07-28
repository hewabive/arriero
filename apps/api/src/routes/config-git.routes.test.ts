import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import { config } from "../config.js";
import { registerConfigGitRoutes } from "./config-git.routes.js";

test("config git stays reachable on a public listener without admin auth", async () => {
  const originalHost = config.host;
  const originalPassword = config.auth.password;
  const originalPasswordHash = config.auth.passwordHash;
  config.host = "0.0.0.0";
  config.auth.password = null;
  config.auth.passwordHash = null;
  try {
    const app = new Hono();
    registerConfigGitRoutes(app);
    const response = await app.request("/api/config-git/validation");
    assert.equal(response.status, 200);
  } finally {
    config.host = originalHost;
    config.auth.password = originalPassword;
    config.auth.passwordHash = originalPasswordHash;
  }
});
