import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { config } from "./config.js";

const cookieName = "arriero_admin";
const passwordHashPrefix = "scrypt$";

type SessionPayload = {
  exp: number;
};

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url").replace(/=+$/, "");
}

function sign(data: string) {
  const secret = config.auth.secret;
  if (!secret) {
    return "";
  }
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyScryptHash(password: string, encoded: string) {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const salt = Buffer.from(saltRaw!, "base64url");
  const expected = Buffer.from(hashRaw!, "base64url");
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createPasswordHash(password: string) {
  const salt = randomBytes(16);
  const n = 16384;
  const r = 8;
  const p = 1;
  const hash = scryptSync(password, salt, 32, { N: n, r, p });
  return `${passwordHashPrefix}${n}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function isAuthEnabled() {
  return Boolean(config.auth.password || config.auth.passwordHash);
}

export function verifyAdminPassword(password: string) {
  if (!isAuthEnabled()) {
    return true;
  }

  if (config.auth.passwordHash) {
    return verifyScryptHash(password, config.auth.passwordHash);
  }

  return safeEqual(password, config.auth.password ?? "");
}

function createSessionToken() {
  const payload: SessionPayload = {
    exp: Math.floor(Date.now() / 1000) + config.auth.sessionTtlSeconds,
  };
  const data = base64Url(JSON.stringify(payload));
  return `${data}.${sign(data)}`;
}

function verifySessionToken(token: string | undefined) {
  if (!isAuthEnabled()) {
    return true;
  }
  if (!token || !config.auth.secret) {
    return false;
  }

  const [data, signature] = token.split(".");
  if (!data || !signature || !safeEqual(sign(data), signature)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as SessionPayload;
    return Number.isFinite(payload.exp) && payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export function isRequestAuthenticated(c: Context) {
  if (verifySessionToken(getCookie(c, cookieName))) {
    return true;
  }
  if (!isAuthEnabled()) {
    return false;
  }
  const token = bearerToken(c);
  return token !== undefined && verifyAdminPassword(token);
}

export function setSessionCookie(c: Context) {
  setCookie(c, cookieName, createSessionToken(), {
    httpOnly: true,
    secure: config.auth.secureCookie,
    sameSite: "Lax",
    path: "/",
    maxAge: config.auth.sessionTtlSeconds,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, cookieName, {
    path: "/",
  });
}

type LoginAttempt = {
  failures: number;
  lockedUntil: number;
  updatedAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

const LOGIN_MAX_FAILURES = 5;
const LOGIN_BASE_LOCK_MS = 60_000;
const LOGIN_MAX_LOCK_MS = 15 * 60_000;
const LOGIN_DECAY_MS = 15 * 60_000;
const LOGIN_TRACKER_LIMIT = 1_024;

function isStaleAttempt(entry: LoginAttempt, now: number) {
  return entry.lockedUntil <= now && now - entry.updatedAt > LOGIN_DECAY_MS;
}

function pruneLoginAttempts(now: number) {
  if (loginAttempts.size <= LOGIN_TRACKER_LIMIT) {
    return;
  }
  for (const [key, entry] of loginAttempts) {
    if (isStaleAttempt(entry, now)) {
      loginAttempts.delete(key);
    }
  }
}

export type LoginRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export function checkLoginRateLimit(
  key: string,
  now: number,
): LoginRateLimitResult {
  const entry = loginAttempts.get(key);
  if (entry && entry.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(
  key: string,
  now: number,
): LoginRateLimitResult {
  const existing = loginAttempts.get(key);
  const base =
    !existing || isStaleAttempt(existing, now) ? 0 : existing.failures;
  const failures = base + 1;
  let lockedUntil = 0;
  if (failures >= LOGIN_MAX_FAILURES) {
    const over = failures - LOGIN_MAX_FAILURES;
    lockedUntil =
      now + Math.min(LOGIN_BASE_LOCK_MS * 2 ** over, LOGIN_MAX_LOCK_MS);
  }
  loginAttempts.set(key, { failures, lockedUntil, updatedAt: now });
  pruneLoginAttempts(now);
  return checkLoginRateLimit(key, now);
}

export function recordLoginSuccess(key: string) {
  loginAttempts.delete(key);
}

export function resetLoginRateLimit() {
  loginAttempts.clear();
}

function isPublicApiPath(path: string) {
  return (
    path === "/api/health" ||
    path === "/api/public/status" ||
    path === "/api/auth/state" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout"
  );
}

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS" || isPublicApiPath(c.req.path)) {
    await next();
    return;
  }

  if (isRequestAuthenticated(c)) {
    await next();
    return;
  }

  return c.json({ error: "authentication required" }, 401);
};
