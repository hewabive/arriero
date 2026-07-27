import type {
  AdminLogin,
  AuthState,
  Instance,
  InstanceHealthSummary,
  PublicStatus,
} from "@arriero/core";

import { nodeRequest, request } from "./http.js";

export async function listInstances() {
  return nodeRequest<{ data: Instance[] }>("/api/instances");
}

export async function getPublicStatus() {
  return request<{ data: PublicStatus }>("/api/public/status");
}

export async function getAuthState() {
  return request<{ data: AuthState }>("/api/auth/state");
}

export async function loginAdmin(input: AdminLogin) {
  return request<{ data: AuthState }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function logoutAdmin() {
  return request<{ data: AuthState }>("/api/auth/logout", {
    method: "POST",
  });
}

export async function listInstanceHealthSummaries() {
  return nodeRequest<{ data: InstanceHealthSummary[] }>(
    "/api/instances/health-summary",
  );
}
