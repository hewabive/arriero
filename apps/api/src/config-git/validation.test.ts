import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { validateConfigBlob, validateConfigRoot } from "./validation.js";

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("validateConfigRoot accepts a minimal portable configuration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-valid-"));
  mkdirSync(resolve(root, "instances"));
  mkdirSync(resolve(root, "proxy"));
  writeJson(resolve(root, "settings.json"), {});
  writeJson(resolve(root, "argument-defaults.json"), { instance: [] });
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "path-catalog.json"), []);
  writeJson(resolve(root, "envs.json"), []);
  writeJson(resolve(root, "nodes.json"), []);
  for (const name of [
    "targets",
    "models",
    "pipelines",
    "endpoints",
    "sources",
  ]) {
    writeJson(resolve(root, "proxy", `${name}.json`), []);
  }

  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });
});

test("validateConfigRoot tolerates dangling machine-state references", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-machine-"));
  mkdirSync(resolve(root, "instances"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "llama-server",
    binaryPath: "/bin/false",
    binaryPathRefId: "no-such-catalog-entry",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });
});

test("validateConfigRoot rejects a repository without configuration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-empty-"));
  writeFileSync(resolve(root, "README.md"), "empty profile\n");

  const result = validateConfigRoot(root);
  assert.equal(result.valid, false);
  assert.match(result.issues[0]?.message ?? "", /no recognized configuration/);
});

test("validateConfigBlob validates a single file by its path kind", () => {
  assert.deepEqual(validateConfigBlob("settings.json", "{}"), []);
  assert.deepEqual(
    validateConfigBlob(
      "instances/worker.json",
      JSON.stringify({
        name: "worker",
        kind: "llama-server",
        binaryPath: "/bin/false",
        args: {},
        env: {},
        memory: [],
        rpcWorkers: [],
      }),
    ),
    [],
  );

  const mismatch = validateConfigBlob(
    "instances/worker.json",
    JSON.stringify({
      name: "other",
      kind: "llama-server",
      binaryPath: "/bin/false",
      args: {},
      env: {},
      memory: [],
      rpcWorkers: [],
    }),
  );
  assert.match(mismatch[0]?.message ?? "", /does not match file name/);

  const invalid = validateConfigBlob("instances/worker.json", "{}");
  assert.equal(invalid.length > 0, true);

  const badIni = validateConfigBlob(
    "presets/router.ini",
    "[model]\nno equals sign here\n",
  );
  assert.equal(badIni.length > 0, true);

  assert.match(
    validateConfigBlob("path-catalog.json", "[]")[0]?.message ?? "",
    /not a restorable/,
  );
  assert.match(
    validateConfigBlob("README.md", "hello")[0]?.message ?? "",
    /not a restorable/,
  );
});

test("validateConfigRoot rejects broken proxy cross-references", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-proxy-refs-"));
  mkdirSync(resolve(root, "instances"));
  mkdirSync(resolve(root, "proxy"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "nodes.json"), [
    { id: "node1", name: "peer", baseUrl: "http://peer:8787", enabled: true },
  ]);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "llama-server",
    binaryPath: "/bin/false",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
  });
  const targetShape = {
    model: null,
    role: "background",
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  };
  writeJson(resolve(root, "proxy", "targets.json"), [
    { id: "t1", name: "gone", endpointId: "external:missing", ...targetShape },
    { id: "t2", name: "self", endpointId: "manager-proxy", ...targetShape },
    {
      id: "t3",
      name: "managed",
      endpointId: "instance:worker",
      ...targetShape,
      model: "explicit-model",
    },
    {
      id: "t4",
      name: "remote-ok",
      endpointId: "remote:node1:far-instance",
      ...targetShape,
    },
  ]);
  writeJson(resolve(root, "proxy", "models.json"), [
    {
      id: "m1",
      modelId: "orphan-target",
      visible: true,
      enabled: true,
      ownedBy: "arriero",
      targetId: "no-such-target",
      routeTo: null,
      description: null,
    },
    {
      id: "m2",
      modelId: "orphan-endpoint",
      visible: true,
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: {
        type: "endpoint",
        endpointId: "external:nope",
        upstreamModel: "up",
      },
      description: null,
    },
  ]);

  const result = validateConfigRoot(root);
  assert.equal(result.valid, false);
  const messages = result.issues.map((issue) => issue.message);
  assert.ok(
    messages.some((message) =>
      message.includes('references missing endpoint "external:missing"'),
    ),
  );
  assert.ok(
    messages.some((message) =>
      message.includes("cannot point to arriero proxy itself"),
    ),
  );
  assert.ok(
    messages.some((message) => message.includes("leave the model empty")),
  );
  assert.ok(
    messages.some((message) =>
      message.includes('references missing target "no-such-target"'),
    ),
  );
  assert.ok(
    messages.some((message) =>
      message.includes('routes to missing endpoint "external:nope"'),
    ),
  );
  assert.equal(
    messages.some((message) => message.includes("remote-ok")),
    false,
  );
});

test("validateConfigRoot rejects rpc workers that nest rpc workers", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-rpc-"));
  mkdirSync(resolve(root, "instances"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "rpc-worker",
    binaryPath: "/bin/false",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [{ instanceName: "other" }],
  });

  const result = validateConfigRoot(root);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) =>
      issue.message.includes("cannot reference other rpc workers"),
    ),
  );
});

test("validateConfigRoot rejects symlinks and broken resource references", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-invalid-"));
  mkdirSync(resolve(root, "instances"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "path-catalog.json"), []);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "llama-server",
    binaryPath: "/bin/false",
    args: {},
    env: {},
    memory: [{ poolId: "missing", bytes: 1 }],
    rpcWorkers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  symlinkSync("/tmp", resolve(root, "outside"));

  const result = validateConfigRoot(root);
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.message.includes("symbolic links")),
  );
  assert.ok(
    result.issues.some((issue) =>
      issue.message.includes("missing resource pool"),
    ),
  );
});

test("validateConfigBlob accepts portable and pre-split envs.json, not envs-state.json", () => {
  assert.deepEqual(
    validateConfigBlob(
      "envs.json",
      JSON.stringify([
        {
          engine: "vllm",
          version: "0.24.0",
          variant: "cuda",
          pythonVersion: "3.12",
          source: { kind: "pypi", extras: [] },
          id: "portable-spec",
        },
      ]),
    ),
    [],
  );
  assert.deepEqual(
    validateConfigBlob(
      "envs.json",
      JSON.stringify([
        {
          engine: "sglang",
          version: "0.5.17",
          variant: "cuda",
          pythonVersion: "3.12",
          source: { kind: "pypi", extras: ["all"] },
          id: "legacy-spec",
          pathCatalogEntryId: "catalog-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ),
    [],
  );
  assert.match(
    validateConfigBlob("envs.json", JSON.stringify([{ id: "broken" }]))[0]
      ?.message ?? "",
    /Invalid/i,
  );
  assert.match(
    validateConfigBlob("envs-state.json", "[]")[0]?.message ?? "",
    /not a restorable/,
  );
});

const webappFixture = {
  name: "chat",
  kind: "open-webui",
  envSpecId: "env-1",
  http: { host: "127.0.0.1", port: 3000 },
  proxySourceId: null,
  autostart: false,
  settings: { type: "open-webui" },
};

test("validateConfigRoot checks webapp files and their references", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-webapps-"));
  mkdirSync(resolve(root, "webapps"));
  writeJson(resolve(root, "resources.json"), []);
  writeJson(resolve(root, "webapps", "chat.json"), webappFixture);

  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });

  writeJson(resolve(root, "envs.json"), []);
  const missingSpec = validateConfigRoot(root);
  assert.equal(missingSpec.valid, false);
  assert.match(
    missingSpec.issues[0]?.message ?? "",
    /missing environment spec "env-1"/,
  );

  writeJson(resolve(root, "envs.json"), [
    {
      engine: "open-webui",
      version: "0.11.0",
      pythonVersion: "3.12",
      source: { kind: "pypi", extras: [] },
      id: "env-1",
    },
  ]);
  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });

  writeJson(resolve(root, "webapps", "chat.json"), {
    ...webappFixture,
    proxySourceId: "src-1",
  });
  const missingSource = validateConfigRoot(root);
  assert.equal(missingSource.valid, false);
  assert.match(
    missingSource.issues[0]?.message ?? "",
    /missing proxy source "src-1"/,
  );

  writeJson(resolve(root, "webapps", "chat.json"), {
    ...webappFixture,
    name: "other",
  });
  const nameMismatch = validateConfigRoot(root);
  assert.equal(nameMismatch.valid, false);
  assert.match(
    nameMismatch.issues[0]?.message ?? "",
    /does not match file name/,
  );
});

test("validateConfigBlob covers webapp files and benchmark prompts", () => {
  assert.deepEqual(
    validateConfigBlob("webapps/chat.json", JSON.stringify(webappFixture)),
    [],
  );
  assert.match(
    validateConfigBlob(
      "webapps/chat.json",
      JSON.stringify({ ...webappFixture, name: "other" }),
    )[0]?.message ?? "",
    /does not match file name/,
  );
  assert.deepEqual(
    validateConfigBlob(
      "benchmark/prompts.json",
      JSON.stringify([
        {
          id: "p1",
          title: "Prompt",
          topic: "test",
          language: "en",
          prefillClass: "short",
          maxTokens: 64,
          messages: [{ role: "user", content: "hi" }],
        },
      ]),
    ),
    [],
  );
  assert.match(
    validateConfigBlob("benchmark/prompts.json", "{}")[0]?.message ?? "",
    /Invalid/i,
  );
});

test("validateConfigRoot accepts pool declarations with derived capacity", () => {
  const root = mkdtempSync(resolve(tmpdir(), "llama-config-pools-"));
  mkdirSync(resolve(root, "instances"));
  writeJson(resolve(root, "resources.json"), [
    {
      id: "gpu0",
      name: "GPU 0",
      kind: "gpu",
      capacityBytes: null,
      reservedBytes: 0,
      deviceRef: "0",
      autoCapacity: true,
    },
    {
      id: "host",
      name: "Host RAM",
      kind: "host",
      capacityBytes: 8_000_000_000,
      reservedBytes: 0,
      deviceRef: null,
      autoCapacity: false,
    },
  ]);
  writeJson(resolve(root, "instances", "worker.json"), {
    name: "worker",
    kind: "llama-server",
    binaryPath: "/bin/false",
    args: {},
    env: {},
    memory: [{ poolId: "gpu0", bytes: 1024 }],
    rpcWorkers: [],
  });

  assert.deepEqual(validateConfigRoot(root), { valid: true, issues: [] });

  writeJson(resolve(root, "resources.json"), [
    {
      id: "gpu0",
      name: "GPU 0",
      kind: "gpu",
      capacityBytes: null,
      reservedBytes: 0,
      deviceRef: "0",
      autoCapacity: false,
    },
  ]);
  const invalid = validateConfigRoot(root);
  assert.equal(invalid.valid, false);
  assert.match(
    invalid.issues[0]?.message ?? "",
    /manual pools must declare capacityBytes/,
  );
});
