import assert from "node:assert/strict";
import { test } from "node:test";

import type { Instance, InstanceKind } from "@arriero/core";

import {
  flushBenchmarkInstanceCache,
  type BenchmarkCacheFlushInput,
} from "./cache-flush.js";

function instance(kind: InstanceKind, args: Instance["args"] = {}): Instance {
  return {
    name: `${kind}-flush`,
    kind,
    args,
    env: {},
    memory: [],
    rpcWorkers: [],
    positionalArgs: [],
  } as unknown as Instance;
}

function harness(
  respond: (method: string, path: string) => Response,
  over: Partial<BenchmarkCacheFlushInput> & { instance: Instance },
) {
  const calls: string[] = [];
  let restarts = 0;
  const input: BenchmarkCacheFlushInput = {
    baseUrl: "http://engine.local",
    model: null,
    launchCliArgs: null,
    launchEnv: {},
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(url).replace("http://engine.local", "");
      calls.push(`${method} ${path}`);
      return respond(method, path);
    }) as typeof fetch,
    signal: new AbortController().signal,
    restart: async () => {
      restarts += 1;
    },
    retryDelayMs: 1,
    attempts: 3,
    ...over,
  };
  return { input, calls, restarts: () => restarts };
}

test("llama.cpp erases every slot when the host prompt cache is off", async () => {
  const { input, calls, restarts } = harness(
    (method, path) =>
      method === "GET" && path === "/slots"
        ? Response.json([{ id: 0 }, { id: 1 }])
        : Response.json({ n_erased: 10 }),
    {
      instance: instance("llama-server"),
      launchCliArgs: ["--port", "8080", "--cache-ram", "0"],
    },
  );
  const result = await flushBenchmarkInstanceCache(input);
  assert.equal(result.method, "slot-erase");
  assert.deepEqual(calls, [
    "GET /slots",
    "POST /slots/0?action=erase",
    "POST /slots/1?action=erase",
  ]);
  assert.equal(restarts(), 0);
});

test("llama.cpp restarts while the host prompt cache is on", async () => {
  const { input, calls, restarts } = harness(() => Response.json({}), {
    instance: instance("llama-server"),
    launchCliArgs: ["--port", "8080"],
  });
  const result = await flushBenchmarkInstanceCache(input);
  assert.equal(result.method, "restart");
  assert.deepEqual(calls, []);
  assert.equal(restarts(), 1);
});

test("a llama.cpp router reloads the benchmarked model", async () => {
  let polls = 0;
  const { input, calls } = harness(
    (method, path) => {
      if (method === "GET" && path === "/v1/models") {
        polls += 1;
        return Response.json({
          data: [
            {
              id: "qwen",
              status: { value: polls > 1 ? "loaded" : "loading" },
            },
          ],
        });
      }
      return Response.json({ success: true });
    },
    {
      instance: instance("llama-server", { "--models-preset": "/presets" }),
      model: "qwen",
      readyTimeoutMs: 10_000,
    },
  );
  const result = await flushBenchmarkInstanceCache(input);
  assert.equal(result.method, "model-reload");
  assert.deepEqual(calls.slice(0, 2), [
    "POST /models/unload",
    "POST /models/load",
  ]);
});

test("vLLM resets its prefix cache only in development mode on localhost", async () => {
  let attempts = 0;
  const devMode = harness(
    () => {
      attempts += 1;
      return Response.json({ success: attempts > 1 });
    },
    {
      instance: instance("vllm", { "--host": "127.0.0.1" }),
      launchEnv: { VLLM_SERVER_DEV_MODE: "1" },
    },
  );
  const reset = await flushBenchmarkInstanceCache(devMode.input);
  assert.equal(reset.method, "reset-prefix-cache");
  assert.equal(attempts, 2);
  assert.equal(
    devMode.calls[0],
    "POST /reset_prefix_cache?reset_external=true",
  );

  const exposed = harness(() => Response.json({ success: true }), {
    instance: instance("vllm", { "--host": "0.0.0.0" }),
    launchEnv: { VLLM_SERVER_DEV_MODE: "1" },
  });
  assert.equal(
    (await flushBenchmarkInstanceCache(exposed.input)).method,
    "restart",
  );
  const production = harness(() => Response.json({ success: true }), {
    instance: instance("vllm", { "--host": "127.0.0.1" }),
  });
  assert.equal(
    (await flushBenchmarkInstanceCache(production.input)).method,
    "restart",
  );
  assert.deepEqual(production.calls, []);
});

test("SGLang flushes once idle and restarts when the endpoint is missing", async () => {
  let attempts = 0;
  const busyThenDone = harness(
    () => {
      attempts += 1;
      return new Response("busy", { status: attempts > 2 ? 200 : 400 });
    },
    { instance: instance("sglang") },
  );
  assert.equal(
    (await flushBenchmarkInstanceCache(busyThenDone.input)).method,
    "flush-cache",
  );
  assert.equal(attempts, 3);

  const missing = harness(() => new Response("", { status: 404 }), {
    instance: instance("sglang"),
  });
  const result = await flushBenchmarkInstanceCache(missing.input);
  assert.equal(result.method, "restart");
  assert.equal(missing.restarts(), 1);

  const stuck = harness(() => new Response("busy", { status: 400 }), {
    instance: instance("sglang"),
  });
  await assert.rejects(flushBenchmarkInstanceCache(stuck.input), /3 attempts/);
});

test("KTransformers restarts", async () => {
  const { input, restarts } = harness(() => Response.json({}), {
    instance: instance("ktransformers"),
  });
  assert.equal((await flushBenchmarkInstanceCache(input)).method, "restart");
  assert.equal(restarts(), 1);
});
