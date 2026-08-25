import { WebappConfigRecordSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { checkWebappStartPreflight } from "./preflight.js";

function record(overrides: Record<string, unknown> = {}) {
  return WebappConfigRecordSchema.parse({
    name: "preflight-test",
    kind: "chat-ui",
    envSpecId: "env-spec-preflight",
    http: { host: "127.0.0.1", port: 3001 },
    settings: { type: "chat-ui" },
    ...overrides,
  });
}

test("chat-ui preflight warns about the empty proxy catalog and open LAN access", async () => {
  const issues = await checkWebappStartPreflight(
    record({ http: { host: "0.0.0.0", port: 3001 } }),
    null,
    { checkPort: false },
  );
  assert.ok(
    issues.some(
      (issue) => issue.level === "error" && issue.field === "envSpecId",
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.level === "warning" && issue.message.includes("no models"),
    ),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.level === "warning" &&
        issue.message.includes("no built-in sign-in"),
    ),
  );
});

test("open-webui preflight keeps the wildcard warning behind the auth toggle", async () => {
  const wildcard = {
    kind: "open-webui",
    settings: { type: "open-webui", auth: true },
    http: { host: "0.0.0.0", port: 3000 },
  };
  const withAuth = await checkWebappStartPreflight(record(wildcard), null, {
    checkPort: false,
  });
  assert.equal(
    withAuth.some((issue) => issue.field === "http.host"),
    false,
  );
  const withoutAuth = await checkWebappStartPreflight(
    record({
      ...wildcard,
      settings: { type: "open-webui", auth: false },
    }),
    null,
    { checkPort: false },
  );
  assert.ok(
    withoutAuth.some(
      (issue) =>
        issue.field === "http.host" &&
        issue.message.includes("authentication disabled"),
    ),
  );
});
