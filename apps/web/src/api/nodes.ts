import type {
  FleetNodeCreate,
  FleetNodeUpdate,
  FleetNodeView,
  FleetResourcesEntry,
  FleetSelf,
} from "@arriero/core";

import { selfRequest } from "./http.js";

export async function listNodes() {
  return selfRequest<{ data: FleetNodeView[] }>("/api/nodes");
}

export async function createNode(input: FleetNodeCreate) {
  return selfRequest<{ data: FleetNodeView }>("/api/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateNode(id: string, input: FleetNodeUpdate) {
  return selfRequest<{ data: FleetNodeView }>(`/api/nodes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteNode(id: string) {
  return selfRequest<{ data: { deleted: boolean } }>(`/api/nodes/${id}`, {
    method: "DELETE",
  });
}

export async function setFleetSelf(nodeId: string | null) {
  return selfRequest<{ data: FleetSelf }>("/api/fleet/self", {
    method: "PUT",
    body: JSON.stringify({ nodeId }),
  });
}

export async function getFleetResources() {
  return selfRequest<{ data: FleetResourcesEntry[] }>("/api/fleet/resources");
}
