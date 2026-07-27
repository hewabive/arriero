import { strict as assert } from "node:assert";
import test from "node:test";

import { AdminLoginSchema } from "@arriero/core";
import { Hono } from "hono";

import {
  createPasswordHash,
  isAuthEnabled,
  isRequestAuthenticated,
  requireAdmin,
  setSessionCookie,
  verifyAdminPassword,
} from "../auth.js";
import { config } from "../config.js";

const originalAuth = { ...config.auth };

test.afterEach(() => {
  Object.assign(config.auth, originalAuth);
});

function configureAuth(input: Partial<typeof config.auth>) {
  Object.assign(config.auth, {
    password: null,
    passwordHash: null,
    secret: null,
    secureCookie: false,
    sessionTtlSeconds: 12 * 60 * 60,
    ...input,
  });
}

function createAuthTestApp() {
  const app = new Hono();
  app.use("/api/*", requireAdmin);

  app.get("/api/public/status", (c) => {
    return c.json({ data: { ok: true } });
  });

  app.get("/api/auth/state", (c) => {
    return c.json({
      data: {
        enabled: isAuthEnabled(),
        authenticated: isRequestAuthenticated(c),
      },
    });
  });

  app.post("/api/auth/login", async (c) => {
    const parsed = AdminLoginSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (!verifyAdminPassword(parsed.data.password)) {
      return c.json({ error: "invalid password" }, 401);
    }
    setSessionCookie(c);
    return c.json({ data: { authenticated: true } });
  });

  app.get("/api/instances", (c) => {
    return c.json({ data: [] });
  });

  return app;
}

test("admin routes stay open when auth is not configured", async () => {
  configureAuth({});
  const app = createAuthTestApp();

  const authState = await app.request("/api/auth/state");
  assert.equal(authState.status, 200);
  assert.deepEqual(await authState.json(), {
    data: { enabled: false, authenticated: true },
  });

  const adminResponse = await app.request("/api/instances");
  assert.equal(adminResponse.status, 200);
});

test("admin routes require a session when password auth is configured", async () => {
  configureAuth({ password: "secret", secret: "test-secret" });
  const app = createAuthTestApp();

  const publicResponse = await app.request("/api/public/status");
  assert.equal(publicResponse.status, 200);

  const adminResponse = await app.request("/api/instances");
  assert.equal(adminResponse.status, 401);
  assert.deepEqual(await adminResponse.json(), {
    error: "authentication required",
  });
});

test("login session cookie unlocks admin routes", async () => {
  configureAuth({ password: "secret", secret: "test-secret" });
  const app = createAuthTestApp();

  const loginResponse = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret" }),
  });
  assert.equal(loginResponse.status, 200);

  const setCookie = loginResponse.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0]!;

  const adminResponse = await app.request("/api/instances", {
    headers: { cookie },
  });
  assert.equal(adminResponse.status, 200);
});

test("scrypt password hashes are accepted", () => {
  const passwordHash = createPasswordHash("secret");
  configureAuth({ passwordHash, secret: "test-secret" });

  assert.equal(verifyAdminPassword("wrong"), false);
  assert.equal(verifyAdminPassword("secret"), true);
});
