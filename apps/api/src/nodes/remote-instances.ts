import { InstanceSchema, type FleetNode, type Instance } from "@arriero/core";

import { fetchNodeJson } from "./remote.js";
import { listNodes } from "./repository.js";

export function parseRemoteInstances(payload: unknown): Instance[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.flatMap((item) => {
    const parsed = InstanceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function fetchNodeInstances(node: FleetNode): Promise<Instance[]> {
  try {
    return parseRemoteInstances(
      await fetchNodeJson<unknown>(node, "instances"),
    );
  } catch {
    return [];
  }
}

export async function listRemoteInstancesByNode(): Promise<
  { node: FleetNode; instances: Instance[] }[]
> {
  return Promise.all(
    listNodes()
      .filter((node) => node.enabled)
      .map(async (node) => ({
        node,
        instances: await fetchNodeInstances(node),
      })),
  );
}
