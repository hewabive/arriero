import { engineDescriptor, INSTANCE_KINDS } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

test("every instance kind has a descriptor with a matching id", () => {
  for (const kind of INSTANCE_KINDS) {
    assert.equal(engineDescriptor(kind).id, kind);
  }
});

test("llama-server descriptor enables the full llama feature set", () => {
  const descriptor = engineDescriptor("llama-server");
  assert.equal(descriptor.http.defaultPort, 8080);
  assert.equal(descriptor.probe.id, "llama-http");
  assert.equal(descriptor.nativeApi, "llama");
  assert.equal(descriptor.launch.injectSlotSavePath, true);
  assert.deepEqual(descriptor.launch.argvPrefix, []);
  assert.equal(descriptor.preflight.engineChecks, "llama-server");
  assert.equal(descriptor.preflight.argumentCatalogParser, "llama-help");
  assert.equal(descriptor.estimator, "gguf");
  assert.equal(descriptor.resourceProfile, "llama-args");
  assert.deepEqual(Object.values(descriptor.proxy), [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    "llama-server",
  ]);
});

test("rpc-worker descriptor opts out of inference-server features", () => {
  const descriptor = engineDescriptor("rpc-worker");
  assert.equal(descriptor.http.defaultPort, 50052);
  assert.equal(descriptor.probe.id, "tcp-accept");
  assert.equal(descriptor.nativeApi, "none");
  assert.equal(descriptor.launch.injectSlotSavePath, false);
  assert.deepEqual(descriptor.launch.argvPrefix, []);
  assert.equal(descriptor.preflight.engineChecks, "none");
  assert.equal(descriptor.preflight.argumentCatalogParser, "none");
  assert.equal(descriptor.estimator, "none");
  assert.equal(descriptor.resourceProfile, "rpc-device-args");
  assert.deepEqual(Object.values(descriptor.proxy), [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    "llama-server",
  ]);
});

test("vllm descriptor uses the OpenAI-compatible start/stop-only contract", () => {
  const descriptor = engineDescriptor("vllm");
  assert.equal(descriptor.http.defaultPort, 8000);
  assert.equal(descriptor.probe.id, "openai-http");
  assert.equal(descriptor.nativeApi, "none");
  assert.deepEqual(descriptor.launch.argvPrefix, ["serve"]);
  assert.equal(descriptor.preflight.engineChecks, "vllm");
  assert.equal(descriptor.preflight.argumentCatalogParser, "vllm-help");
  assert.equal(descriptor.logs.parser, "vllm");
  assert.equal(descriptor.resourceProfile, "vllm-args");
  assert.equal(descriptor.estimator, "vllm-gpu-util");
  assert.deepEqual(descriptor.proxy, {
    serveEndpoint: true,
    requestLease: true,
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
    reasoningControl: false,
    translationDialect: "openai-compatible",
  });
});

test("sglang descriptor declares the upstream SGLang lifecycle contract", () => {
  const descriptor = engineDescriptor("sglang");
  assert.equal(descriptor.displayName, "SGLang");
  assert.equal(descriptor.http.defaultPort, 30000);
  assert.equal(descriptor.probe.id, "openai-http");
  assert.equal(descriptor.probe.httpTimeoutMs, 15_000);
  assert.equal(descriptor.nativeApi, "none");
  assert.deepEqual(descriptor.launch, {
    injectSlotSavePath: false,
    argv: "argparse-flags",
    argvPrefix: [],
    pythonModule: "sglang.launch_server",
  });
  assert.equal(descriptor.preflight.engineChecks, "sglang");
  assert.equal(descriptor.preflight.argumentCatalogParser, "sglang-help");
  assert.equal(descriptor.logs.parser, "sglang");
  assert.equal(descriptor.estimator, "none");
  assert.equal(descriptor.resourceProfile, "sglang-args");
  assert.equal(descriptor.processTree.policy, "all-descendants");
  assert.equal(descriptor.concurrency, "sglang-max-running-requests");
  assert.equal(descriptor.admission, "confirmable");
  assert.equal(descriptor.defaultEvictionPolicy, "preemptible");
  assert.deepEqual(descriptor.form, {
    creatable: true,
    modelSource: "free-text",
  });
  assert.deepEqual(descriptor.proxy, {
    serveEndpoint: true,
    requestLease: true,
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
    reasoningControl: false,
    translationDialect: "openai-compatible",
  });
});

test("only ktransformers uses strict memory admission", () => {
  for (const kind of INSTANCE_KINDS) {
    assert.equal(
      engineDescriptor(kind).admission,
      kind === "ktransformers" ? "strict" : "confirmable",
    );
  }
});

test("ktransformers descriptor declares the SGLang-KT lifecycle contract", () => {
  const descriptor = engineDescriptor("ktransformers");
  assert.equal(descriptor.displayName, "KTransformers (SGLang-KT)");
  assert.equal(descriptor.http.defaultPort, 30000);
  assert.equal(descriptor.probe.id, "openai-http");
  assert.equal(descriptor.nativeApi, "none");
  assert.deepEqual(descriptor.launch, {
    injectSlotSavePath: false,
    argv: "argparse-flags",
    argvPrefix: [],
    pythonModule: "sglang.launch_server",
  });
  assert.equal(descriptor.preflight.engineChecks, "ktransformers");
  assert.equal(descriptor.preflight.argumentCatalogParser, "sglang-help");
  assert.equal(descriptor.logs.parser, "sglang");
  assert.equal(descriptor.estimator, "none");
  assert.equal(descriptor.resourceProfile, "ktransformers-hybrid");
  assert.equal(descriptor.processTree.policy, "all-descendants");
  assert.equal(descriptor.concurrency, "sglang-max-running-requests");
  assert.equal(descriptor.defaultEvictionPolicy, "idle-only");
  assert.equal(descriptor.form.creatable, true);
  assert.deepEqual(descriptor.proxy, {
    serveEndpoint: true,
    requestLease: true,
    modelLoadUnload: false,
    slotSave: false,
    streamResume: false,
    sseTimings: false,
    reasoningControl: false,
    translationDialect: "openai-compatible",
  });
});
