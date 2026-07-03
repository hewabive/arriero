import type { Instance, RpcWorkerCandidate } from "@llama-manager/core";
import { hostname } from "node:os";

import { listInstances } from "../instances/repository.js";
import { rpcWorkerEndpoint } from "../instances/endpoint.js";
import { listRemoteInstancesByNode } from "./remote-instances.js";

function isWorker(instance: Instance): boolean {
  return instance.kind === "rpc-worker";
}

function endpointLabel(instance: Instance, host?: string): string | null {
  const endpoint = rpcWorkerEndpoint(instance);
  if (!endpoint) {
    return null;
  }
  return `${host ?? endpoint.host}:${endpoint.port}`;
}

export async function listRpcWorkerCandidates(): Promise<RpcWorkerCandidate[]> {
  const localName = hostname();
  const local: RpcWorkerCandidate[] = listInstances()
    .filter(isWorker)
    .map((instance) => ({
      nodeId: null,
      nodeName: localName,
      instanceName: instance.name,
      endpoint: endpointLabel(instance),
      status: instance.status,
    }));

  const remoteGroups = await listRemoteInstancesByNode();
  const remote: RpcWorkerCandidate[] = remoteGroups.flatMap(
    ({ node, instances }) => {
      const host = new URL(node.baseUrl).hostname;
      return instances.filter(isWorker).map((instance) => ({
        nodeId: node.id,
        nodeName: node.name,
        instanceName: instance.name,
        endpoint: endpointLabel(instance, host),
        status: instance.status,
      }));
    },
  );

  return [...local, ...remote];
}
