import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import type { ApiEndpointCreateInput } from "@arriero/core";
import { Hono } from "hono";

import { config } from "../config.js";
import { resetConfigFilesCache } from "./config-files.js";
import {
  createApiEndpoint,
  deleteApiEndpoint,
  updateApiEndpoint,
} from "./endpoints.js";
import { registerOpenAiProxyRoutes } from "./protocol-routes.js";
import { updateApiProxySettings } from "./settings.js";
import { createApiProxySource } from "./sources.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
});

function buildApp() {
  const app = new Hono();
  registerOpenAiProxyRoutes(app, "/v1");
  registerOpenAiProxyRoutes(app, "/proxy/v1");
  return app;
}

function endpoint(overrides: Partial<ApiEndpointCreateInput> = {}) {
  return createApiEndpoint({
    name: "files-provider",
    baseUrl: "http://127.0.0.1:1/v1",
    profile: "openai",
    apiKey: "provider-key",
    ...overrides,
  });
}

async function upstream(
  t: TestContext,
  reply: {
    status?: number;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  } = {},
) {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    response.writeHead(
      reply.status ?? 200,
      reply.headers ?? { "content-type": "application/json" },
    );
    response.end(reply.body ?? '{"id":"file-123","object":"file"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}/api/v1` };
}

test("Files upload preserves multipart bytes, fields, and provider credentials", async (t) => {
  const target = await upstream(t, { status: 201 });
  const provider = endpoint({
    baseUrl: target.baseUrl,
    extraHeaders: { "x-provider": "files" },
  });
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("expires_after[seconds]", "3600");
  form.append("file", new Blob([new Uint8Array([0, 255, 1, 128])]), "test.bin");
  const request = new Request("http://localhost/v1/files", {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "x-api-key": "client-key",
      "x-arriero-endpoint": provider.id,
    },
    body: form,
  });
  const original = Buffer.from(await request.clone().arrayBuffer());
  const response = await buildApp().request(request);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).id, "file-123");
  assert.equal(target.requests.length, 1);
  const received = target.requests[0]!;
  assert.equal(received.url, "/api/v1/files");
  assert.equal(received.method, "POST");
  assert.deepEqual(received.body, original);
  assert.equal(
    received.headers["content-type"],
    request.headers.get("content-type"),
  );
  assert.equal(received.headers.authorization, "Bearer provider-key");
  assert.equal(received.headers["x-api-key"], undefined);
  assert.equal(received.headers["x-arriero-endpoint"], undefined);
  assert.equal(received.headers["x-provider"], "files");
});

test("Files list, retrieve, delete, and content work on both public prefixes", async (t) => {
  const target = await upstream(t);
  endpoint({ baseUrl: target.baseUrl, passthrough: false });
  const app = buildApp();
  for (const prefix of ["/v1", "/proxy/v1"]) {
    for (const [method, path] of [
      ["GET", "/files?purpose=batch&limit=2&after=file-previous&order=asc"],
      ["GET", "/files/file-123"],
      ["DELETE", "/files/file-123"],
      ["GET", "/files/file-123/content"],
    ] as const) {
      const response = await app.request(`${prefix}${path}`, { method });
      assert.equal(response.status, 200);
      await response.text();
      const received = target.requests.at(-1)!;
      assert.equal(received.url, `/api/v1${path}`);
      assert.equal(received.method, method);
      assert.equal(received.body.length, 0);
    }
  }
});

test("Files content preserves binary data and download headers after decompression", async (t) => {
  const content = Buffer.from([0, 255, 128, 13, 10, 1]);
  const compressed = gzipSync(content);
  const target = await upstream(t, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="test.bin"',
      "content-encoding": "gzip",
      "content-length": String(compressed.length),
    },
    body: compressed,
  });
  endpoint({ baseUrl: target.baseUrl });
  const response = await buildApp().request("/v1/files/file-123/content");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  assert.equal(
    response.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="test.bin"',
  );
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
});

test("Files chooses an explicit endpoint and rejects ambiguous or ineligible selection", async (t) => {
  const first = await upstream(t);
  const second = await upstream(t);
  endpoint({ baseUrl: first.baseUrl });
  const selected = endpoint({ name: "second", baseUrl: second.baseUrl });
  const disabled = endpoint({ name: "disabled", enabled: false });
  const anthropic = endpoint({ name: "anthropic", profile: "anthropic" });
  const app = buildApp();
  for (const id of [
    "",
    "missing",
    disabled.id,
    anthropic.id,
    "manager-proxy",
  ]) {
    const response = await app.request("/v1/files", {
      headers: { "x-arriero-endpoint": id },
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error.code,
      "arriero_proxy_files_endpoint_required",
    );
  }
  const response = await app.request("/v1/files", {
    headers: { "x-arriero-endpoint": selected.id },
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(first.requests.length, 0);
  assert.equal(second.requests.length, 1);
});

test("Files rejects missing providers and ignores disabled or non-OpenAI providers for automatic selection", async (t) => {
  const app = buildApp();
  assert.equal((await app.request("/v1/files")).status, 400);
  endpoint({ name: "disabled", enabled: false });
  endpoint({ name: "anthropic", profile: "anthropic" });
  const target = await upstream(t);
  endpoint({ baseUrl: target.baseUrl, apiKey: "", authHeaderName: null });
  const response = await app.request("/v1/files", {
    headers: {
      authorization: "Bearer client-secret",
      "x-api-key": "client-secret",
    },
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(target.requests[0]!.headers.authorization, undefined);
  assert.equal(target.requests[0]!.headers["x-api-key"], undefined);
});

test("Files uses the configured default, lets the header override it, and supports clearing", async (t) => {
  const first = await upstream(t);
  const second = await upstream(t);
  const fallback = endpoint({ baseUrl: first.baseUrl });
  const override = endpoint({ name: "override", baseUrl: second.baseUrl });
  updateApiProxySettings({ filesEndpointId: fallback.id });
  const app = buildApp();
  for (const prefix of ["/v1", "/proxy/v1"]) {
    const response = await app.request(`${prefix}/files`);
    assert.equal(response.status, 200);
    await response.text();
    const explicit = await app.request(`${prefix}/files`, {
      headers: { "x-arriero-endpoint": override.id },
    });
    assert.equal(explicit.status, 200);
    await explicit.text();
    assert.equal(
      (
        await app.request(`${prefix}/files`, {
          headers: { "x-arriero-endpoint": "missing" },
        })
      ).status,
      400,
    );
  }
  assert.equal(first.requests.length, 2);
  assert.equal(second.requests.length, 2);
  updateApiProxySettings({ filesEndpointId: null });
  assert.equal((await app.request("/v1/files")).status, 400);
  updateApiEndpoint(override.id, { enabled: false });
  const automatic = await app.request("/v1/files");
  assert.equal(automatic.status, 200);
  await automatic.text();
  assert.equal(first.requests.length, 3);
});

test("Files never falls back from an unavailable default to another provider", async (t) => {
  const target = await upstream(t);
  const available = endpoint({ baseUrl: target.baseUrl });
  const selected = endpoint({ name: "selected" });
  updateApiProxySettings({ filesEndpointId: selected.id });
  const app = buildApp();
  for (const change of [
    () => updateApiEndpoint(selected.id, { enabled: false }),
    () =>
      updateApiEndpoint(selected.id, { enabled: true, profile: "anthropic" }),
    () => deleteApiEndpoint(selected.id),
  ]) {
    change();
    const response = await app.request("/v1/files");
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error.code,
      "arriero_proxy_files_endpoint_required",
    );
  }
  assert.equal(target.requests.length, 0);
  const explicit = await app.request("/v1/files", {
    headers: { "x-arriero-endpoint": available.id },
  });
  assert.equal(explicit.status, 200);
  await explicit.text();
});

test("Files applies the source gate before endpoint resolution for every operation", async () => {
  updateApiProxySettings({ allowAnonymous: false });
  const app = buildApp();
  for (const [method, path] of [
    ["POST", "/files"],
    ["GET", "/files"],
    ["GET", "/files/file-123"],
    ["DELETE", "/files/file-123"],
    ["GET", "/files/file-123/content"],
  ] as const) {
    const response = await app.request(`/v1${path}`, { method });
    assert.equal(response.status, 423);
    assert.equal(
      (await response.json()).error.code,
      "arriero_proxy_source_required",
    );
  }
  createApiProxySource({
    name: "blocked",
    enabled: false,
    apiKey: "blocked-key",
    note: "",
    blockedMessage: "",
  });
  updateApiProxySettings({ allowAnonymous: true });
  const blocked = await app.request("/v1/files", {
    headers: { authorization: "Bearer blocked-key" },
  });
  assert.equal(blocked.status, 423);
  assert.equal(
    (await blocked.json()).error.code,
    "arriero_proxy_source_disabled",
  );
});

test("Files preserves upstream errors and retry headers", async (t) => {
  const body =
    '{"error":{"message":"Files are unavailable","code":"unsupported"}}';
  const target = await upstream(t, {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "30" },
    body,
  });
  endpoint({ baseUrl: target.baseUrl });
  const response = await buildApp().request("/v1/files");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(await response.text(), body);
});

test("Files reports transport failures and missing provider credentials", async () => {
  const provider = endpoint();
  const app = buildApp();
  const unavailable = await app.request("/v1/files");
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).error.type, "server_error");
  const missing = endpoint({
    name: "missing-key",
    apiKey: "",
    apiKeyEnvVar: "TEST_FILES_MISSING_KEY",
  });
  const response = await app.request("/v1/files", {
    headers: { "x-arriero-endpoint": missing.id },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /TEST_FILES_MISSING_KEY/);
  const controller = new AbortController();
  controller.abort();
  const aborted = await app.request("/v1/files", {
    signal: controller.signal,
    headers: { "x-arriero-endpoint": provider.id },
  });
  assert.equal(aborted.status, 499);
});

test(
  "Files streams uploads and downloads before either body completes",
  { timeout: 5000 },
  async (t) => {
    const server = createServer(async (request, response) => {
      request.once("data", () => server.emit("upload-started"));
      await once(request, "end");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("first");
      server.once("finish-download", () => response.end("last"));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    endpoint({ baseUrl: `http://127.0.0.1:${address.port}/v1` });
    createApiProxySource({
      name: "client",
      enabled: true,
      apiKey: "client-key",
      note: "",
      blockedMessage: "",
    });
    updateApiProxySettings({ allowAnonymous: false });
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const started = once(server, "upload-started", { signal: t.signal });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        authorization: "Bearer client-key",
      },
      body: body.readable,
      duplex: "half",
      signal: t.signal,
    };
    const pending = buildApp().request(
      new Request("http://localhost/proxy/v1/files", init),
    );
    await writer.write(new TextEncoder().encode("--test\r\n"));
    await started;
    await writer.write(new TextEncoder().encode("--test--\r\n"));
    await writer.close();
    const response = await pending;
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "first");
    server.emit("finish-download");
    const last = await reader.read();
    assert.equal(new TextDecoder().decode(last.value), "last");
    assert.equal((await reader.read()).done, true);
  },
);
