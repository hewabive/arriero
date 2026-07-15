import { EnvironmentCreateSchema } from "@llama-manager/core";
import assert from "node:assert/strict";
import test from "node:test";

import { offlineEnvironmentPolicyError } from "./offline-policy.js";

function input(source: unknown) {
  return EnvironmentCreateSchema.parse({
    version: "0.24.0",
    variant: "cpu",
    pythonVersion: "3.12.13",
    pythonProvisioning: "mirror",
    pythonMirrorUrl: "file:///media/airgap-bundle/python-runtime-mirror",
    source,
  });
}

test("closed-network vLLM plan has no public package or runtime URL", () => {
  const spec = input({
    kind: "wheel",
    url: "https://gitea.local/api/packages/pypi/pypi/files/vllm.whl",
    sha256: "a".repeat(64),
    dependencyIndexUrl: "https://gitea.local/api/packages/pypi/pypi/simple",
    torchBackend: "cpu",
  });
  assert.equal(offlineEnvironmentPolicyError(spec), null);
});

test("offline pypi source must name a closed-network index", () => {
  assert.match(
    offlineEnvironmentPolicyError(
      input({ kind: "pypi", extras: [], indexUrl: "https://pypi.org/simple" }),
    )!,
    /public host/,
  );
  assert.match(
    offlineEnvironmentPolicyError(input({ kind: "pypi", extras: [], indexUrl: null }))!,
    /explicit closed-network index/,
  );
});

test("offline wheel source cannot silently resolve dependencies from public PyPI", () => {
  assert.match(
    offlineEnvironmentPolicyError(
      input({
        kind: "wheel",
        url: "file:///media/vllm.whl",
        sha256: "a".repeat(64),
        dependencyIndexUrl: null,
        torchBackend: "cpu",
      }),
    )!,
    /dependency index/,
  );
});
