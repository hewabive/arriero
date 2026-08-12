import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { apiProxyForwardUrl, forwardApiProxyRequest } from "./forwarder.js";

function readRequestBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("apiProxyForwardUrl maps instance API prefix and upstream path", () => {
  assert.equal(
    apiProxyForwardUrl(
      "http://127.0.0.1:8081/api/v1",
      "/v1/chat/completions",
      "?stream=false",
    ),
    "http://127.0.0.1:8081/api/v1/chat/completions?stream=false",
  );
});

test("forwardApiProxyRequest strips the configured client headers", async () => {
  const server = createServer(async (request, response) => {
    await readRequestBody(request);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        tenantLabels: request.headers["x-tenant-labels"] ?? null,
        customLabels: request.headers["x-custom-labels"] ?? null,
        requestId: request.headers["x-request-id"] ?? null,
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await forwardApiProxyRequest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      method: "POST",
      upstreamPath: "/v1/chat/completions",
      search: "",
      headers: new Headers({
        "content-type": "application/json",
        "x-tenant-labels": '{"team":"platform"}',
        "x-custom-labels": '{"team":"platform"}',
        "x-request-id": "abc",
      }),
      stripHeaders: ["x-tenant-labels"],
      body: { model: "qwen", messages: [] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      tenantLabels: null,
      customLabels: null,
      requestId: "abc",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("forwardApiProxyRequest forwards JSON request and response", async () => {
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json");
    response.setHeader("x-upstream", "llama");
    response.end(
      JSON.stringify({
        method: request.method,
        url: request.url,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        host: request.headers.host,
        body: JSON.parse(body) as unknown,
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await forwardApiProxyRequest({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      method: "POST",
      upstreamPath: "/v1/chat/completions",
      search: "?autoload=true",
      headers: new Headers({
        "content-type": "application/json",
        "content-length": "999",
        host: "example.test",
      }),
      body: { model: "qwen", messages: [] },
      upstreamHeaders: { authorization: "Bearer upstream-secret" },
      modelOverride: "upstream-qwen",
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream"), "llama");
    assert.deepEqual(await response.json(), {
      method: "POST",
      url: "/v1/chat/completions?autoload=true",
      contentType: "application/json",
      authorization: "Bearer upstream-secret",
      host: `127.0.0.1:${address.port}`,
      body: { model: "upstream-qwen", messages: [] },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
