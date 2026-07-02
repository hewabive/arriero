import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchErrorCode,
  isEventStream,
  proxyRequestHeaders,
  proxyResponseHeaders,
  proxyTargetUrl,
} from "./http.js";

test("fetchErrorCode reads a direct error code", () => {
  const error = Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
  assert.equal(fetchErrorCode(error), "ECONNREFUSED");
});

test("fetchErrorCode unwraps the cause chain", () => {
  const cause = Object.assign(new Error("timed out"), {
    code: "UND_ERR_HEADERS_TIMEOUT",
  });
  const error = new TypeError("fetch failed", { cause });
  assert.equal(fetchErrorCode(error), "UND_ERR_HEADERS_TIMEOUT");
});

test("fetchErrorCode returns null when no code is present", () => {
  assert.equal(fetchErrorCode(new Error("plain")), null);
  assert.equal(fetchErrorCode("not an error"), null);
});

test("proxyTargetUrl joins base path, request path and query", () => {
  assert.equal(
    proxyTargetUrl(
      "http://127.0.0.1:8080/api/",
      "/v1/chat/completions",
      "?x=1",
    ),
    "http://127.0.0.1:8080/api/v1/chat/completions?x=1",
  );
});

test("proxyRequestHeaders drops hop-by-hop and request-owned headers", () => {
  const headers = proxyRequestHeaders({
    authorization: "Bearer test",
    connection: "keep-alive",
    "content-length": "100",
    host: "example.test",
    "x-request-id": "abc",
  });

  assert.equal(headers.get("authorization"), "Bearer test");
  assert.equal(headers.get("x-request-id"), "abc");
  assert.equal(headers.has("connection"), false);
  assert.equal(headers.has("content-length"), false);
  assert.equal(headers.has("host"), false);
});

test("proxyRequestHeaders drops client stream-session headers", () => {
  const headers = proxyRequestHeaders({
    "X-Conversation-Id": "conv-1",
    "X-Stream-Resume": "1",
    "x-request-id": "abc",
  });

  assert.equal(headers.has("x-conversation-id"), false);
  assert.equal(headers.has("x-stream-resume"), false);
  assert.equal(headers.get("x-request-id"), "abc");
});

test("proxyResponseHeaders drops hop-by-hop and decoded-body headers", () => {
  const headers = proxyResponseHeaders({
    "content-type": "application/json",
    "transfer-encoding": "chunked",
    "content-encoding": "gzip",
    "content-length": "42",
  });

  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.has("transfer-encoding"), false);
  assert.equal(headers.has("content-encoding"), false);
  assert.equal(headers.has("content-length"), false);
});

test("isEventStream detects server-sent events", () => {
  assert.equal(
    isEventStream(new Headers({ "content-type": "text/event-stream" })),
    true,
  );
  assert.equal(
    isEventStream(new Headers({ "content-type": "application/json" })),
    false,
  );
});
