import type {
  Instance,
  ProcessPreflightIssue,
  RpcWorkerRef,
} from "@llama-manager/core";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";

import { rpcWorkerEndpoint } from "../instances/endpoint.js";
import { fetchNodeInstances } from "../nodes/remote-instances.js";
import { getNode } from "../nodes/repository.js";

export const RPC_SLOW_FABRIC_RTT_MS = 5;
const RPC_FABRIC_RTT_TIMEOUT_MS = 1_200;
const RPC_FABRIC_RTT_SAMPLES = 3;

type FabricEndpoint = { host: string; port: number };

type WorkerState =
  | {
      ok: true;
      status: Instance["status"];
      nodeLabel: string;
      fabric: FabricEndpoint | null;
    }
  | { ok: false; message: string };

function sameRef(left: RpcWorkerRef, right: RpcWorkerRef) {
  return (
    left.nodeId === right.nodeId && left.instanceName === right.instanceName
  );
}

function tcpConnectMs(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port });
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(RPC_FABRIC_RTT_TIMEOUT_MS);
    socket.once("connect", () => finish(performance.now() - started));
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
  });
}

async function measureRttMs(
  host: string,
  port: number,
): Promise<number | null> {
  let best: number | null = null;
  for (let sample = 0; sample < RPC_FABRIC_RTT_SAMPLES; sample += 1) {
    const value = await tcpConnectMs(host, port);
    if (value === null) {
      return best;
    }
    best = best === null ? value : Math.min(best, value);
  }
  return best;
}

export function fabricIssue(
  instanceName: string,
  rttMs: number | null,
): ProcessPreflightIssue | null {
  if (rttMs === null) {
    return null;
  }
  if (rttMs > RPC_SLOW_FABRIC_RTT_MS) {
    return {
      level: "warning",
      field: "rpcWorkers",
      message: `rpc worker "${instanceName}" is ~${Math.round(rttMs)} ms away (RTT). RPC synchronizes over the network on every token, so a slow/WAN fabric yields low throughput — co-locate the worker on a fast LAN for usable speed.`,
    };
  }
  return null;
}

async function resolveWorkerState(
  ref: RpcWorkerRef,
  peers: Instance[],
): Promise<WorkerState> {
  if (ref.nodeId === null) {
    const worker = peers.find((peer) => peer.name === ref.instanceName);
    if (!worker) {
      return {
        ok: false,
        message: `rpc worker "${ref.instanceName}" was not found on this node`,
      };
    }
    if (worker.kind !== "rpc-worker") {
      return {
        ok: false,
        message: `instance "${ref.instanceName}" is not an rpc-worker`,
      };
    }
    return {
      ok: true,
      status: worker.status,
      nodeLabel: "this node",
      fabric: null,
    };
  }

  const node = getNode(ref.nodeId);
  if (!node) {
    return {
      ok: false,
      message: `rpc worker node "${ref.nodeId}" is not registered`,
    };
  }
  const worker = (await fetchNodeInstances(node)).find(
    (instance) => instance.name === ref.instanceName,
  );
  if (!worker) {
    return {
      ok: false,
      message: `rpc worker "${ref.instanceName}" was not found on node "${node.name}"`,
    };
  }
  if (worker.kind !== "rpc-worker") {
    return {
      ok: false,
      message: `instance "${ref.instanceName}" on node "${node.name}" is not an rpc-worker`,
    };
  }
  const endpoint = rpcWorkerEndpoint(worker);
  const fabric: FabricEndpoint | null = endpoint
    ? { host: new URL(node.baseUrl).hostname, port: endpoint.port }
    : null;
  return {
    ok: true,
    status: worker.status,
    nodeLabel: `node "${node.name}"`,
    fabric,
  };
}

export function referencingOrchestrators(
  workerName: string,
  peers: Instance[],
): string[] {
  const holders: string[] = [];
  for (const peer of peers) {
    if (peer.kind !== "llama-server") {
      continue;
    }
    if (peer.status !== "running" && peer.status !== "starting") {
      continue;
    }
    if (
      peer.rpcWorkers.some(
        (ref) => ref.nodeId === null && ref.instanceName === workerName,
      )
    ) {
      holders.push(peer.name);
    }
  }
  return holders;
}

function exclusivityHolder(
  ref: RpcWorkerRef,
  instanceName: string,
  peers: Instance[],
): string | null {
  for (const peer of peers) {
    if (peer.name === instanceName || peer.kind !== "llama-server") {
      continue;
    }
    if (peer.status !== "running" && peer.status !== "starting") {
      continue;
    }
    if (peer.rpcWorkers.some((peerRef) => sameRef(peerRef, ref))) {
      return peer.name;
    }
  }
  return null;
}

export async function validateRpcWorkerReadiness(
  instance: Instance,
  peers: Instance[],
): Promise<ProcessPreflightIssue[]> {
  if (instance.kind !== "llama-server" || instance.rpcWorkers.length === 0) {
    return [];
  }

  const orchestratorActive =
    instance.status === "running" || instance.status === "starting";

  const evaluated = await Promise.all(
    instance.rpcWorkers.map(async (ref) => {
      const state = await resolveWorkerState(ref, peers);
      const holder =
        state.ok && state.status === "running"
          ? exclusivityHolder(ref, instance.name, peers)
          : null;
      const measureFabric =
        !orchestratorActive &&
        !holder &&
        state.ok &&
        state.status === "running" &&
        state.fabric !== null;
      const rttMs = measureFabric
        ? await measureRttMs(state.fabric!.host, state.fabric!.port)
        : null;
      return { ref, state, holder, measureFabric, rttMs };
    }),
  );

  const issues: ProcessPreflightIssue[] = [];
  for (const { ref, state, holder, measureFabric, rttMs } of evaluated) {
    if (!state.ok) {
      issues.push({
        level: "error",
        field: "rpcWorkers",
        message: state.message,
      });
      continue;
    }
    if (state.status !== "running") {
      issues.push({
        level: "error",
        field: "rpcWorkers",
        message: `rpc worker "${ref.instanceName}" on ${state.nodeLabel} is not running (${state.status}); start it before this instance`,
      });
      continue;
    }
    if (holder) {
      issues.push({
        level: "error",
        field: "rpcWorkers",
        message: `rpc worker "${ref.instanceName}" is already in use by running instance "${holder}"; an rpc-server serves one orchestrator at a time`,
      });
      continue;
    }
    if (measureFabric) {
      const fabric = fabricIssue(ref.instanceName, rttMs);
      if (fabric) {
        issues.push(fabric);
      }
    }
  }
  return issues;
}
