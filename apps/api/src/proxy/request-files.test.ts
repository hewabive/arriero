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
    "2026-06-10/2026-06-10T12-34-56-789Z-0197a000-0000-7000-8000-000000000001/01-capture-request.json",
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

test("rejects paths escaping the request files root", () => {
  assert.equal(readApiProxyRequestFile("../arriero.db"), null);
  assert.equal(readApiProxyRequestFile("/etc/passwd"), null);
  assert.equal(
    readApiProxyRequestFile("2026-06-10/../../config/settings.json"),
    null,
  );
  assert.equal(readApiProxyRequestFile("missing-day/missing.json"), null);
});
