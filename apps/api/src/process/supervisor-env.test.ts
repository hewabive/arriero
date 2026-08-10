import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../config.js";
import { managedProcessEnvironment } from "./supervisor.js";

function instance(kind: Instance["kind"], env: Instance["env"] = {}): Instance {
  return {
    name: `${kind}-env-test`,
    kind,
    binaryPath: process.execPath,
    binaryPathRefId: "binary-ref",
    args: {},
    positionalArgs: kind === "vllm" ? ["test-model"] : undefined,
    env,
    memory: [],
    rpcWorkers: [],
    status: "stopped",
    pid: null,
  };
}

test("vLLM processes default their cache to managed runtime storage", () => {
  const env = managedProcessEnvironment(instance("vllm"), { PATH: "/bin" });

  assert.equal(env.VLLM_CACHE_ROOT, config.vllmCacheDir);
  assert.equal(env.PATH, "/bin");
});

test("an explicit vLLM cache root takes precedence", () => {
  const inherited = managedProcessEnvironment(instance("vllm"), {
    VLLM_CACHE_ROOT: "/inherited/cache",
  });
  const configured = managedProcessEnvironment(
    instance("vllm", { VLLM_CACHE_ROOT: "/instance/cache" }),
    { VLLM_CACHE_ROOT: "/inherited/cache" },
  );

  assert.equal(inherited.VLLM_CACHE_ROOT, "/inherited/cache");
  assert.equal(configured.VLLM_CACHE_ROOT, "/instance/cache");
});

test("non-vLLM processes do not receive a vLLM cache variable", () => {
  const env = managedProcessEnvironment(instance("llama-server"), {});

  assert.equal(env.VLLM_CACHE_ROOT, undefined);
});
