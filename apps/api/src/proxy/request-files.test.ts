import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readApiProxyRequestFile,
  saveApiProxyRequestFile,
} from "./request-files.js";

function saveInput(
  over: Partial<Parameters<typeof saveApiProxyRequestFile>[0]> = {},
) {
  return {
    traceId: "0197a000-0000-7000-8000-000000000001",
    traceAt: "2026-06-10T12:34:56.789Z",
    kind: "capture-request",
    label: "before replace",
    protocol: "openai" as const,
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "public-model",
    data: { model: "public-model", messages: [] },
    ...over,
  };
}

test("saves sequential per-request files and reads them back", () => {
  const first = saveApiProxyRequestFile(saveInput());
  const second = saveApiProxyRequestFile(saveInput({ label: null }));

  assert.equal(first.name, "01-capture-request.json");
  assert.equal(second.name, "02-capture-request.json");
  assert.equal(
    first.path,
    "public-model/2026-06-10T12-34-56-789Z-0197a000-0000-7000-8000-000000000001/01-capture-request.json",
  );
  assert.ok(first.bytes > 0);

  const record = readApiProxyRequestFile(first.path);
  assert.ok(record);
  assert.equal(record.traceId, "0197a000-0000-7000-8000-000000000001");
  assert.equal(record.kind, "capture-request");
  assert.equal(record.label, "before replace");
  assert.deepEqual(record.data, { model: "public-model", messages: [] });

  const secondRecord = readApiProxyRequestFile(second.path);
  assert.ok(secondRecord);
  assert.equal(secondRecord.label, null);
});

test("sanitizes the model id into a safe directory name", () => {
  const slash = saveApiProxyRequestFile(
    saveInput({ modelId: "anthropic/claude-3.5-sonnet" }),
  );
  assert.ok(slash.path.startsWith("anthropic-claude-3.5-sonnet/"));

  const record = readApiProxyRequestFile(slash.path);
  assert.ok(record);
  assert.equal(record.modelId, "anthropic/claude-3.5-sonnet");

  const dots = saveApiProxyRequestFile(saveInput({ modelId: ".." }));
  assert.ok(dots.path.startsWith("unknown-model/"));

  const long = saveApiProxyRequestFile(saveInput({ modelId: "m".repeat(500) }));
  assert.ok(long.path.startsWith(`${"m".repeat(100)}/`));
});

test("rejects paths escaping the request files root", () => {
  assert.equal(readApiProxyRequestFile("../arriero.db"), null);
  assert.equal(readApiProxyRequestFile("/etc/passwd"), null);
  assert.equal(
    readApiProxyRequestFile("public-model/../../config/settings.json"),
    null,
  );
  assert.equal(readApiProxyRequestFile("missing-model/missing.json"), null);
});
