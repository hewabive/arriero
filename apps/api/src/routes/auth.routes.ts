import { AdminLoginSchema } from "@arriero/core";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Hono } from "hono";

import {
  checkLoginRateLimit,
  clearSessionCookie,
  isAuthEnabled,
  isRequestAuthenticated,
  recordLoginFailure,
  recordLoginSuccess,
  setSessionCookie,
  verifyAdminPassword,
} from "../auth.js";

export function registerAuthRoutes(app: Hono) {
  app.get("/api/auth/state", (c) => {
    return c.json({
      data: {
        enabled: isAuthEnabled(),
        authenticated: isRequestAuthenticated(c),
      },
    });
  });

  app.post("/api/auth/login", async (c) => {
    const clientKey = getConnInfo(c).remote.address ?? "unknown";
    const now = Date.now();

    const limit = checkLoginRateLimit(clientKey, now);
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return c.json(
        {
          error: "too many attempts",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        429,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }

    const parsed = AdminLoginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (!verifyAdminPassword(parsed.data.password)) {
      const after = recordLoginFailure(clientKey, now);
      if (!after.allowed) {
        c.header("Retry-After", String(after.retryAfterSeconds));
        return c.json(
          {
            error: "too many attempts",
            retryAfterSeconds: after.retryAfterSeconds,
          },
          429,
        );
      }
      return c.json({ error: "invalid password" }, 401);
    }
    recordLoginSuccess(clientKey);
    setSessionCookie(c);
    return c.json({
      data: {
        enabled: isAuthEnabled(),
        authenticated: true,
      },
    });
  });

  app.post("/api/auth/logout", (c) => {
    clearSessionCookie(c);
    return c.json({
      data: {
        enabled: isAuthEnabled(),
        authenticated: false,
      },
    });
  });
}
