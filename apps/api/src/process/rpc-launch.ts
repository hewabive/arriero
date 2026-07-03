import type { FleetNode, Instance, RpcWorkerRef } from "@llama-manager/core";

import { getInstanceRecord } from "../instances/config-files.js";
import { rpcWorkerEndpoint } from "../instances/endpoint.js";
import { fetchNodeInstances } from "../nodes/remote-instances.js";
import { getNode } from "../nodes/repository.js";

function localRpcWorkerHost(ref: RpcWorkerRef): string {
  const record = getInstanceRecord(ref.instanceName);
  if (!record || record.kind !== "rpc-worker") {
    throw new Error(`rpc worker "${ref.instanceName}" not found on this node`);
  }
  const endpoint = rpcWorkerEndpoint(record);
  if (!endpoint) {
    throw new Error(
      `rpc worker "${ref.instanceName}" has no reachable host:port`,
    );
  }
  return `${endpoint.host}:${endpoint.port}`;
}

async function remoteRpcWorkerHost(ref: RpcWorkerRef): Promise<string> {
  const node = ref.nodeId ? getNode(ref.nodeId) : null;
  if (!node) {
    throw new Error(`rpc worker node "${ref.nodeId}" is not registered`);
  }
  const worker = (await fetchNodeInstances(node)).find(
    (item) => item.name === ref.instanceName,
  );
  if (!worker || worker.kind !== "rpc-worker") {
    throw new Error(
      `rpc worker "${ref.instanceName}" not found on node "${node.name}"`,
    );
  }
  if (worker.status !== "running") {
    throw new Error(
      `rpc worker "${ref.instanceName}" on node "${node.name}" is not running`,
    );
  }
  const endpoint = rpcWorkerEndpoint(worker);
  if (!endpoint) {
    throw new Error(
      `rpc worker "${ref.instanceName}" on node "${node.name}" has no port`,
    );
  }
  return `${nodeHost(node)}:${endpoint.port}`;
}

function nodeHost(node: FleetNode): string {
  return new URL(node.baseUrl).hostname;
}

export async function resolveRpcArgs(
  instance: Pick<Instance, "kind" | "rpcWorkers">,
): Promise<string[]> {
  if (instance.kind !== "llama-server" || instance.rpcWorkers.length === 0) {
    return [];
  }
  const hosts: string[] = [];
  for (const ref of instance.rpcWorkers) {
    hosts.push(
      ref.nodeId === null
        ? localRpcWorkerHost(ref)
        : await remoteRpcWorkerHost(ref),
    );
  }
  return ["--rpc", hosts.join(",")];
}
