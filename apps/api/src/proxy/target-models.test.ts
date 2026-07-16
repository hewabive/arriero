import assert from "node:assert/strict";
import test from "node:test";

import type { Instance } from "@llama-manager/core";

import {
  buildApiProxyTargetModelCatalog,
  isRouterInstance,
} from "./target-models.js";

function instance(name: string, args: Instance["args"]): Instance {
  return {
    name,
    kind: "llama-server",
    rpcWorkers: [],
    binaryPath: "/tmp/llama-server",
    binaryPathRefId: "bin",
    args,
    env: {},
    memory: [],
    status: "running",
    pid: 1,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

test("single-model instance implies its model without a probe", async () => {
  const catalog = await buildApiProxyTargetModelCatalog([
    instance("single-A", {
      "--host": "127.0.0.1",
      "--port": 9001,
      "--model": "/models/qwen.gguf",
    }),
  ]);

  const group = catalog.groups.find((item) => item.endpointName === "single-A");
  assert.ok(group);
  assert.equal(group.kind, "managed-instance");
  assert.equal(group.modelSource, "implied");
  assert.equal(group.impliedModel, "qwen.gguf");
});

test("an --alias wins over the model path for the implied model", async () => {
  const catalog = await buildApiProxyTargetModelCatalog([
    instance("aliased", {
      "--host": "127.0.0.1",
      "--port": 9004,
      "--model": "/models/qwen.gguf",
      "--alias": "my-qwen",
    }),
  ]);

  const group = catalog.groups.find((item) => item.endpointName === "aliased");
  assert.equal(group?.impliedModel, "my-qwen");
});

test("router instance (preset, no --model) needs a probe, no implied model", async () => {
  const router = instance("router-B", {
    "--host": "127.0.0.1",
    "--port": 9002,
    "--models-preset": "missing-preset",
  });
  assert.equal(isRouterInstance(router), true);

  const catalog = await buildApiProxyTargetModelCatalog([router]);
  const group = catalog.groups.find((item) => item.endpointName === "router-B");
  assert.ok(group);
  assert.equal(group.kind, "managed-instance");
  assert.equal(group.modelSource, "probe");
  assert.equal(group.impliedModel, null);
});

test("an rpc-worker instance is not exposed as a proxy target", async () => {
  const worker: Instance = {
    ...instance("rpc-worker-A", { "--host": "0.0.0.0", "--port": 50052 }),
    kind: "rpc-worker",
  };

  const catalog = await buildApiProxyTargetModelCatalog([worker]);
  assert.equal(
    catalog.groups.some((item) => item.endpointName === "rpc-worker-A"),
    false,
  );
});

test("vllm implies its positional model while stopped", async () => {
  const vllm: Instance = {
    ...instance("vllm", {}),
    kind: "vllm",
    positionalArgs: ["Qwen/Qwen3-8B"],
    status: "stopped",
  };
  const catalog = await buildApiProxyTargetModelCatalog([vllm]);
  assert.equal(catalog.groups[0]?.modelSource, "implied");
  assert.equal(catalog.groups[0]?.impliedModel, "Qwen/Qwen3-8B");
});

test("vllm served-model-name overrides the positional model", async () => {
  const vllm: Instance = {
    ...instance("vllm", { "--served-model-name": "qwen-local" }),
    kind: "vllm",
    positionalArgs: ["Qwen/Qwen3-8B"],
  };
  const catalog = await buildApiProxyTargetModelCatalog([vllm]);
  assert.equal(catalog.groups[0]?.impliedModel, "qwen-local");
});

test("KTransformers implies stable identity from typed configuration", async () => {
  const kt: Instance = {
    ...instance("kt", { "--host": "127.0.0.1", "--port": 30000 }),
    kind: "ktransformers",
    status: "stopped",
    engineConfig: {
      type: "ktransformers",
      model: "deepseek-ai/DeepSeek-V3",
      cpuWeights: "/models/deepseek-cpu",
      method: "FP8",
      servedModelName: "deepseek-local",
    },
    scheduling: { evictionPolicy: "idle-only" },
  };
  const catalog = await buildApiProxyTargetModelCatalog([kt]);
  assert.equal(catalog.groups[0]?.modelSource, "implied");
  assert.equal(catalog.groups[0]?.impliedModel, "deepseek-local");

  kt.engineConfig = {
    type: "ktransformers",
    model: "deepseek-ai/DeepSeek-V3",
    cpuWeights: "/models/deepseek-cpu",
    method: "FP8",
  };
  const fallback = await buildApiProxyTargetModelCatalog([kt]);
  assert.equal(fallback.groups[0]?.impliedModel, "deepseek-ai/DeepSeek-V3");

  kt.engineConfig = { ...kt.engineConfig, model: "/new/mount/DeepSeek-V3" };
  const moved = await buildApiProxyTargetModelCatalog([kt]);
  assert.equal(moved.groups[0]?.impliedModel, "DeepSeek-V3");
});

test("a configured --model wins over --models-preset (single, not router)", async () => {
  const mixed = instance("mixed", {
    "--host": "127.0.0.1",
    "--port": 9003,
    "--model": "/models/a.gguf",
    "--models-preset": "ignored",
  });
  assert.equal(isRouterInstance(mixed), false);

  const catalog = await buildApiProxyTargetModelCatalog([mixed]);
  const group = catalog.groups.find((item) => item.endpointName === "mixed");
  assert.equal(group?.kind, "managed-instance");
  assert.equal(group?.modelSource, "implied");
  assert.equal(group?.impliedModel, "a.gguf");
});
