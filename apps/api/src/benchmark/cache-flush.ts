import {
  argString,
  engineDescriptor,
  isRouterInstance,
  type BenchmarkCacheFlushMethod,
  type Instance,
} from "@arriero/core";

import { asObject } from "../proxy/json.js";

export type BenchmarkCacheFlushResult = {
  method: BenchmarkCacheFlushMethod;
  detail: string;
};

export type BenchmarkCacheFlushInput = {
  instance: Instance;
  baseUrl: string;
  model: string | null;
  launchCliArgs: string[] | null;
  launchEnv: Record<string, string>;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  restart: () => Promise<void>;
  retryDelayMs?: number;
  attempts?: number;
  readyTimeoutMs?: number;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_ATTEMPTS = 20;
const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("canceled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("canceled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function flagValue(argv: string[] | null, flags: string[]): string | null {
  if (!argv) {
    return null;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index] ?? "";
    for (const flag of flags) {
      if (entry === flag) {
        return argv[index + 1] ?? null;
      }
      if (entry.startsWith(`${flag}=`)) {
        return entry.slice(flag.length + 1);
      }
    }
  }
  return null;
}

function listensOnLoopback(instance: Instance): boolean {
  const http = engineDescriptor(instance.kind).http;
  if (http.loopbackOnly) {
    return true;
  }
  const host =
    argString(instance.args, [...http.hostArgKeys]) ?? http.defaultHost;
  return LOOPBACK_HOSTS.has(host);
}

async function post(
  input: BenchmarkCacheFlushInput,
  path: string,
  body?: unknown,
): Promise<Response> {
  return input.fetchImpl(`${input.baseUrl}${path}`, {
    method: "POST",
    signal: input.signal,
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

async function restartFlush(
  input: BenchmarkCacheFlushInput,
  reason: string,
): Promise<BenchmarkCacheFlushResult> {
  await input.restart();
  return { method: "restart", detail: reason };
}

async function eraseLlamaSlots(
  input: BenchmarkCacheFlushInput,
): Promise<BenchmarkCacheFlushResult> {
  const response = await input.fetchImpl(`${input.baseUrl}/slots`, {
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`listing slots returned HTTP ${response.status}`);
  }
  const slots = (await response.json()) as unknown;
  const ids = Array.isArray(slots)
    ? slots.flatMap((slot) => {
        const id = asObject(slot)?.id;
        return typeof id === "number" ? [id] : [];
      })
    : [];
  for (const id of ids) {
    const erased = await post(input, `/slots/${id}?action=erase`);
    if (!erased.ok) {
      throw new Error(`erasing slot ${id} returned HTTP ${erased.status}`);
    }
  }
  return { method: "slot-erase", detail: `erased ${ids.length} slots` };
}

async function modelLoaded(
  input: BenchmarkCacheFlushInput,
  model: string,
): Promise<boolean> {
  const response = await input.fetchImpl(`${input.baseUrl}/v1/models`, {
    signal: input.signal,
  });
  if (!response.ok) {
    return false;
  }
  const data = asObject(await response.json())?.data;
  const entry = Array.isArray(data)
    ? data.map(asObject).find((item) => item?.id === model)
    : undefined;
  const status = asObject(entry?.status)?.value;
  return entry !== undefined && (status === undefined || status === "loaded");
}

async function reloadRouterModel(
  input: BenchmarkCacheFlushInput,
  model: string,
): Promise<BenchmarkCacheFlushResult> {
  for (const action of ["unload", "load"] as const) {
    const response = await post(input, `/models/${action}`, { model });
    if (!response.ok) {
      throw new Error(`${action} of ${model} returned HTTP ${response.status}`);
    }
  }
  const deadline =
    Date.now() + (input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  while (!(await modelLoaded(input, model))) {
    if (Date.now() >= deadline) {
      throw new Error(`${model} did not come back after reloading`);
    }
    await delay(POLL_MS, input.signal);
  }
  return { method: "model-reload", detail: `unloaded and reloaded ${model}` };
}

async function flushLlama(
  input: BenchmarkCacheFlushInput,
): Promise<BenchmarkCacheFlushResult> {
  const cacheRam = flagValue(input.launchCliArgs, ["--cache-ram", "-cram"]);
  if (cacheRam !== null && Number(cacheRam) === 0) {
    return eraseLlamaSlots(input);
  }
  if (isRouterInstance(input.instance) && input.model) {
    return reloadRouterModel(input, input.model);
  }
  return restartFlush(
    input,
    "the host-memory prompt cache (--cache-ram) has no clearing endpoint",
  );
}

async function retrying(
  input: BenchmarkCacheFlushInput,
  attempt: () => Promise<"done" | "busy" | "missing">,
): Promise<"done" | "missing"> {
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  for (let index = 0; index < attempts; index += 1) {
    const outcome = await attempt();
    if (outcome !== "busy") {
      return outcome;
    }
    await delay(input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, input.signal);
  }
  throw new Error(
    `the engine kept refusing to flush its cache after ${attempts} attempts`,
  );
}

async function flushVllm(
  input: BenchmarkCacheFlushInput,
): Promise<BenchmarkCacheFlushResult> {
  if (input.launchEnv.VLLM_SERVER_DEV_MODE !== "1") {
    return restartFlush(
      input,
      "reset_prefix_cache needs VLLM_SERVER_DEV_MODE=1 at launch",
    );
  }
  if (!listensOnLoopback(input.instance)) {
    return restartFlush(
      input,
      "development endpoints are used only on an instance that listens on localhost",
    );
  }
  const outcome = await retrying(input, async () => {
    const response = await post(
      input,
      "/reset_prefix_cache?reset_external=true",
    );
    if (response.status === 404) {
      return "missing";
    }
    if (!response.ok) {
      throw new Error(`reset_prefix_cache returned HTTP ${response.status}`);
    }
    return asObject(await response.json())?.success === true ? "done" : "busy";
  });
  if (outcome === "missing") {
    return restartFlush(input, "reset_prefix_cache is not served");
  }
  return {
    method: "reset-prefix-cache",
    detail: "reset the prefix cache, connector caches included",
  };
}

async function flushSglang(
  input: BenchmarkCacheFlushInput,
): Promise<BenchmarkCacheFlushResult> {
  const outcome = await retrying(input, async () => {
    const response = await post(input, "/flush_cache");
    await response.body?.cancel();
    if (response.status === 404) {
      return "missing";
    }
    if (response.status === 400) {
      return "busy";
    }
    if (!response.ok) {
      throw new Error(`flush_cache returned HTTP ${response.status}`);
    }
    return "done";
  });
  if (outcome === "missing") {
    return restartFlush(input, "flush_cache is not served");
  }
  return { method: "flush-cache", detail: "flushed the radix cache" };
}

export function flushBenchmarkInstanceCache(
  input: BenchmarkCacheFlushInput,
): Promise<BenchmarkCacheFlushResult> {
  switch (engineDescriptor(input.instance.kind).benchmarkCacheFlush) {
    case "llama-server":
      return flushLlama(input);
    case "vllm-reset-prefix-cache":
      return flushVllm(input);
    case "sglang-flush-cache":
      return flushSglang(input);
    case "restart":
      return restartFlush(input, "the engine has no cache flush endpoint");
  }
}

export async function waitForBenchmarkEndpointReady(input: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number | undefined;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    const ready = await input
      .fetchImpl(`${input.baseUrl}/v1/models`, { signal: input.signal })
      .then(
        async (response) => {
          await response.body?.cancel();
          return response.ok;
        },
        () => false,
      );
    if (ready) {
      return;
    }
    if (input.signal.aborted) {
      throw new Error("canceled");
    }
    if (Date.now() >= deadline) {
      throw new Error("the instance did not become ready after the restart");
    }
    await delay(POLL_MS, input.signal);
  }
}
