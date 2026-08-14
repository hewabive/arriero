import type { InstanceKind, RpcWorkerRef } from "@arriero/core";

export function validateInstanceRpcWorkers(input: {
  kind?: InstanceKind | undefined;
  rpcWorkers?: RpcWorkerRef[] | undefined;
}) {
  if (
    input.kind === "rpc-worker" &&
    input.rpcWorkers &&
    input.rpcWorkers.length > 0
  ) {
    return "rpc-worker instances cannot reference other rpc workers";
  }
  return null;
}
