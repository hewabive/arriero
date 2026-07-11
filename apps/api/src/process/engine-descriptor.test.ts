import { engineDescriptor, INSTANCE_KINDS } from "@llama-manager/core";
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
  ]);
});

test("vllm descriptor uses the OpenAI-compatible start/stop-only contract", () => {
  const descriptor = engineDescriptor("vllm");
  assert.equal(descriptor.http.defaultPort, 8000);
  assert.equal(descriptor.probe.id, "openai-http");
  assert.equal(descriptor.nativeApi, "none");
  assert.deepEqual(descriptor.launch.argvPrefix, ["serve"]);
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
  });
});
