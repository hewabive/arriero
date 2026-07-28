import assert from "node:assert/strict";
import { test } from "node:test";

import { instanceArgsNeedHttps } from "./https-usage.js";

test("a local model path needs no HTTPS-capable binary", () => {
  assert.equal(
    instanceArgsNeedHttps({ "--model": "/models/qwen.gguf", "--port": 8080 }),
    false,
  );
});

test("every HuggingFace repo alias counts", () => {
  for (const name of ["-hf", "-hfr", "--hf-repo"]) {
    assert.equal(
      instanceArgsNeedHttps({ [name]: "unsloth/model:Q4_K_M" }),
      true,
    );
  }
});

test("model URLs, docker repos and draft repos count", () => {
  assert.equal(
    instanceArgsNeedHttps({ "--model-url": "https://example.com/m.gguf" }),
    true,
  );
  assert.equal(instanceArgsNeedHttps({ "-dr": "ai/smollm2" }), true);
  assert.equal(
    instanceArgsNeedHttps({ "--hf-repo-draft": "user/draft" }),
    true,
  );
});

test("serving TLS counts, since a binary without OpenSSL falls back to plaintext", () => {
  assert.equal(
    instanceArgsNeedHttps({ "--ssl-key-file": "/etc/key.pem" }),
    true,
  );
});

test("an inert flag does not count", () => {
  assert.equal(instanceArgsNeedHttps({ "--hf-repo": "" }), false);
  assert.equal(instanceArgsNeedHttps({ "--hf-repo": null }), false);
  assert.equal(instanceArgsNeedHttps({ "--ssl-key-file": false }), false);
});
