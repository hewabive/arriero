import type {
  FleetNodeCreate,
  FleetNodeUpdate,
  FleetNodeView,
  FleetResourcesEntry,
  FleetSystemEntry,
} from "@arriero/core";

import { request } from "./http.js";

export async function listNodes() {
  return request<{ data: FleetNodeView[] }>("/api/nodes");
}

export async function createNode(input: FleetNodeCreate) {
  return request<{ data: FleetNodeView }>("/api/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateNode(id: string, input: FleetNodeUpdate) {
  return request<{ data: FleetNodeView }>(`/api/nodes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteNode(id: string) {
  return request<{ data: { deleted: boolean } }>(`/api/nodes/${id}`, {
    method: "DELETE",
  });
}

export async function getFleetSystem() {
  return request<{ data: FleetSystemEntry[] }>("/api/fleet/system");
}

export async function getFleetResources() {
  return request<{ data: FleetResourcesEntry[] }>("/api/fleet/resources");
}
