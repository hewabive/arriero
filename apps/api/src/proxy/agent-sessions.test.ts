import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";
import { Hono } from "hono";
import { config } from "../config.js";
import { registerEndpointRoutes } from "../routes/endpoints.routes.js";
import { registerProxyRoutes } from "../routes/proxy.routes.js";
import { resetConfigFilesCache } from "./config-files.js";
import { createApiEndpoint, updateApiEndpoint } from "./endpoints.js";
import { registerOpenAiProxyRoutes } from "./protocol-routes.js";
import { updateApiProxySettings } from "./settings.js";
import { createApiProxySource, updateApiProxySource } from "./sources.js";
import {
  clearApiProxyTraceHistory,
  listApiProxyTraces,
} from "./traces-repository.js";

beforeEach(() => {
  rmSync(config.proxyConfigDir, { recursive: true, force: true });
  rmSync(config.secretsFile, { force: true });
  mkdirSync(config.proxyConfigDir, { recursive: true });
  resetConfigFilesCache();
  clearApiProxyTraceHistory();
});

function app() {
  const result = new Hono();
  registerOpenAiProxyRoutes(result, "/v1");
  registerOpenAiProxyRoutes(result, "/proxy/v1");
  registerEndpointRoutes(result);
  registerProxyRoutes(result);
  return result;
}

async function upstream(t: TestContext, status = 200) {
  const requests: Array<{
    path: string;
    method: string;
    headers: IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      path: req.url!,
      method: req.method!,
      headers: req.headers,
      body,
    });
    res.writeHead(status, {
      "content-type": "application/json",
      "x-request-id": "upstream-request",
    });
    res.end(
      JSON.stringify(
        status < 400
          ? {
              data: {
                identity: "unchanged",
                body: body ? JSON.parse(body) : null,
              },
            }
          : {
              error: {
                message: "agent session head conflict",
                code: "agent_error",
              },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = createApiEndpoint({
    name: "rag",
    baseUrl: `http://127.0.0.1:${address.port}/nested/v1/`,
    apiKey: "registered-rag-principal-key",
    extraHeaders: { "x-endpoint": "rag" },
  });
  updateApiProxySettings({ agentSessionEndpointId: endpoint.id });
  return { endpoint, requests };
}

test("request inspection forwards opaque IDs and endpoint credentials under both prefixes", async (t) => {
  const { requests } = await upstream(t);
  const api = app();
  const id = "llm-arena:p:battle:uuid:a /ю?x=%2F";
  for (const prefix of ["/v1", "/proxy/v1"]) {
    const response = await api.request(
      `${prefix}/agent-requests/${encodeURIComponent(id)}`,
      {
        headers: {
          authorization: "Bearer caller-key",
          "x-rag-external-user-id": "user-1",
          "x-custom-labels": "untrusted",
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-request-id"), "upstream-request");
    assert.deepEqual(await response.json(), {
      data: { identity: "unchanged", body: null },
    });
    const forwarded = requests.at(-1)!;
    assert.equal(
      forwarded.path,
      `/nested/v1/agent-requests/${encodeURIComponent(id)}`,
    );
    assert.equal(forwarded.method, "GET");
    assert.equal(forwarded.body, "");
    assert.equal(
      forwarded.headers.authorization,
      "Bearer registered-rag-principal-key",
    );
    assert.equal(forwarded.headers["x-rag-external-user-id"], "user-1");
    assert.equal(forwarded.headers["x-endpoint"], "rag");
    assert.equal(forwarded.headers["x-custom-labels"], undefined);
  }
  const traces = listApiProxyTraces({ limit: 10 });
  assert.equal(traces.length, 2);
  for (const trace of traces) {
    assert.equal(trace.endpoint, "agent-requests.get");
    assert.equal(trace.targetName, "rag");
    assert.equal(trace.ok, true);
    assert.deepEqual(trace.schedulerActions, []);
    assert.deepEqual(trace.files, []);
  }
});

test("clone payloads retain owner, pinned heads and unknown fields without model rewriting", async (t) => {
  const { requests } = await upstream(t, 201);
  const body = {
    sourceConversationId: "source",
    targetConversationId: "branch",
    targetExternalUserId: "%D1%8E",
    expectedHeadItemId: "head",
    expectedWorkspaceRevisionId: "workspace",
    futureField: "retained",
  };
  for (const prefix of ["/v1", "/proxy/v1"]) {
    const response = await app().request(`${prefix}/agent-sessions/clones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(JSON.parse(requests.at(-1)!.body), body);
    assert.equal(requests.at(-1)!.path, "/nested/v1/agent-sessions/clones");
  }
});

test("upstream conflicts are passed through once without retry", async (t) => {
  const { requests } = await upstream(t, 409);
  const response = await app().request("/v1/agent-sessions/clones", {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { message: "agent session head conflict", code: "agent_error" },
  });
  assert.equal(requests.length, 1);
});

test("the source access policy gates management requests before forwarding", async (t) => {
  const { requests } = await upstream(t);
  const source = createApiProxySource({
    name: "arena",
    apiKey: "arena-source-key",
    enabled: true,
    note: "",
    blockedMessage: "",
  });
  updateApiProxySettings({ allowAnonymous: false });
  const api = app();
  for (const path of ["/v1/agent-requests/id", "/v1/agent-sessions/clones"]) {
    const init = path.endsWith("clones") ? { method: "POST", body: "{}" } : {};
    for (const headers of [{}, { authorization: "Bearer wrong-key" }]) {
      const denied = await api.request(path, { ...init, headers });
      assert.equal(denied.status, 423);
    }
    const allowed = await api.request(path, {
      ...init,
      headers: { authorization: "Bearer arena-source-key" },
    });
    assert.equal(allowed.status, 200);
  }
  assert.equal(requests.length, 2);
  updateApiProxySource(source.id, { enabled: false });
  const disabled = await api.request("/v1/agent-requests/id", {
    headers: { authorization: "Bearer arena-source-key" },
  });
  assert.equal(disabled.status, 423);
  assert.equal(requests.length, 2);
});

test("unconfigured or disabled endpoints fail closed and malformed JSON never reaches upstream", async (t) => {
  const api = app();
  assert.equal((await api.request("/v1/agent-requests/id")).status, 503);
  const { endpoint, requests } = await upstream(t);
  const malformed = await api.request("/v1/agent-sessions/clones", {
    method: "POST",
    body: "{",
  });
  assert.equal(malformed.status, 400);
  updateApiEndpoint(endpoint.id, { enabled: false });
  assert.equal((await api.request("/v1/agent-requests/id")).status, 503);
  assert.equal(requests.length, 0);
  assert.equal(
    (
      await api.request("/v1/agent-requests/retries", {
        method: "POST",
        body: "{}",
      })
    ).status,
    404,
  );
});

test("settings reject missing backends and deletion protects the selected endpoint", async (t) => {
  const { endpoint } = await upstream(t);
  const api = app();
  const invalid = await api.request("/api/proxy/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentSessionEndpointId: "missing" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (await api.request(`/api/endpoints/${endpoint.id}`, { method: "DELETE" }))
      .status,
    409,
  );
  const cleared = await api.request("/api/proxy/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentSessionEndpointId: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(
    (await api.request(`/api/endpoints/${endpoint.id}`, { method: "DELETE" }))
      .status,
    200,
  );
});
