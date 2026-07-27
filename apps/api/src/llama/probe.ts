import type {
  ApiProbeRequest,
  ApiProbeResult,
  Instance,
  EndpointProbe,
  LlamaModelDiagnostics,
  LlamaProbe,
} from "@arriero/core";

import { connect } from "node:net";
import { performance } from "node:perf_hooks";

import { instanceApiProbeTarget } from "./api-probe-request.js";
import {
  instanceBaseUrl,
  modelRecordsFromProbe,
  objectBody,
  probeJson,
  requestJsonProbe,
  rpcWorkerEndpoint,
} from "../instances/endpoint.js";

export * from "./errors.js";
export * from "./capabilities.js";
export * from "./model-actions.js";
export * from "./api-probe-request.js";

const API_PROBE_TIMEOUT_MS = 10 * 60 * 1_000;
const ROUTER_MODEL_DIAGNOSTICS_LIMIT = 12;

const LLAMA_PROBE_PATHS = {
  health: "/health",
  props: "/props",
  slots: "/slots",
  models: "/v1/models",
} as const;

function failedEndpoint(url: string, error: string): EndpointProbe {
  return {
    ok: false,
    url,
    status: null,
    latencyMs: 0,
    error,
  };
}

export function offlineLlamaProbe(
  instance: Instance,
  error: string,
): LlamaProbe {
  const baseUrl = instanceBaseUrl(instance);
  const endpoint = (path: string): EndpointProbe =>
    failedEndpoint(baseUrl ? `${baseUrl}${path}` : "", error);
  return {
    baseUrl,
    health: endpoint(LLAMA_PROBE_PATHS.health),
    props: endpoint(LLAMA_PROBE_PATHS.props),
    slots: endpoint(LLAMA_PROBE_PATHS.slots),
    models: endpoint(LLAMA_PROBE_PATHS.models),
    modelDiagnostics: {},
  };
}

function isRouterProps(probe: EndpointProbe): boolean {
  return objectBody(probe)?.role === "router";
}

function shouldProbeRouterModelDiagnostics(status: string | null) {
  return ["loaded", "sleeping"].includes(status?.toLowerCase() ?? "");
}

async function probeRouterModelDiagnostics(
  baseUrl: string,
  models: EndpointProbe,
): Promise<Record<string, LlamaModelDiagnostics>> {
  const activeModels = modelRecordsFromProbe(models)
    .filter((model) => shouldProbeRouterModelDiagnostics(model.status))
    .slice(0, ROUTER_MODEL_DIAGNOSTICS_LIMIT);

  const entries = await Promise.all(
    activeModels.map(async (model) => {
      const query = new URLSearchParams({
        model: model.id,
        autoload: "false",
      });
      const [props, slots, metrics, loraAdapters] = await Promise.all([
        probeJson(`${baseUrl}/props?${query.toString()}`),
        probeJson(`${baseUrl}/slots?${query.toString()}`),
        probeJson(`${baseUrl}/metrics?${query.toString()}`),
        probeJson(`${baseUrl}/lora-adapters?${query.toString()}`),
      ]);

      return [
        model.id,
        {
          id: model.id,
          props,
          slots,
          metrics,
          loraAdapters,
        },
      ] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export async function requestInstanceApiProbe(
  instance: Instance,
  input: ApiProbeRequest,
): Promise<ApiProbeResult> {
  const target = instanceApiProbeTarget(instance, input);

  return {
    kind: input.kind,
    endpoint: target.endpoint,
    requestBody: target.requestBody,
    response: await requestJsonProbe(target.url, {
      method: "POST",
      body: JSON.stringify(target.requestBody),
      headers: { "content-type": "application/json" },
      timeoutMs: API_PROBE_TIMEOUT_MS,
    }),
  };
}

const RPC_PROBE_TIMEOUT_MS = 1_500;

function probeTcpAccept(
  host: string,
  port: number,
  url: string,
): Promise<EndpointProbe> {
  return new Promise((resolveDone) => {
    const started = performance.now();
    const socket = connect({ host, port });
    let settled = false;
    const finish = (probe: EndpointProbe) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveDone(probe);
    };
    socket.setTimeout(RPC_PROBE_TIMEOUT_MS);
    socket.once("connect", () =>
      finish({
        ok: true,
        url,
        status: null,
        latencyMs: performance.now() - started,
      }),
    );
    socket.once("timeout", () =>
      finish({
        ok: false,
        url,
        status: null,
        latencyMs: performance.now() - started,
        error: "connection timed out",
      }),
    );
    socket.once("error", (error) =>
      finish({
        ok: false,
        url,
        status: null,
        latencyMs: performance.now() - started,
        error: (error as Error).message,
      }),
    );
  });
}

export async function probeRpcWorker(instance: Instance): Promise<LlamaProbe> {
  const notApplicable = failedEndpoint("", "not applicable for rpc-server");
  const endpoint = rpcWorkerEndpoint(instance);
  if (!endpoint) {
    return {
      baseUrl: "",
      health: failedEndpoint(
        "",
        "rpc-server endpoint is not configured (--host/--port)",
      ),
      props: notApplicable,
      slots: notApplicable,
      models: notApplicable,
      modelDiagnostics: {},
    };
  }
  const url = `tcp://${endpoint.host}:${endpoint.port}`;
  return {
    baseUrl: url,
    health: await probeTcpAccept(endpoint.host, endpoint.port, url),
    props: notApplicable,
    slots: notApplicable,
    models: notApplicable,
    modelDiagnostics: {},
  };
}

export async function probeLlamaServer(
  instance: Instance,
): Promise<LlamaProbe> {
  const baseUrl = instanceBaseUrl(instance);
  if (!baseUrl) {
    const unsupported = failedEndpoint(
      "",
      "UNIX socket probing is not implemented yet",
    );
    return {
      baseUrl,
      health: unsupported,
      props: unsupported,
      slots: unsupported,
      models: unsupported,
      modelDiagnostics: {},
    };
  }

  const [health, props, slots, models] = await Promise.all([
    probeJson(`${baseUrl}${LLAMA_PROBE_PATHS.health}`),
    probeJson(`${baseUrl}${LLAMA_PROBE_PATHS.props}`),
    probeJson(`${baseUrl}${LLAMA_PROBE_PATHS.slots}`),
    probeJson(`${baseUrl}${LLAMA_PROBE_PATHS.models}`),
  ]);
  const modelDiagnostics =
    isRouterProps(props) && models.ok
      ? await probeRouterModelDiagnostics(baseUrl, models)
      : {};

  return {
    baseUrl,
    health,
    props,
    slots,
    models,
    modelDiagnostics,
  };
}
