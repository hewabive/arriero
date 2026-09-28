import type {
  AdminLogin,
  AuthState,
  Instance,
  InstanceHealthSummary,
  PublicStatus,
} from "@arriero/core";

import { request, selfRequest } from "./http.js";

export async function listInstances() {
  return request<{ data: Instance[] }>("/api/instances");
}

export async function listSelfInstances() {
  return selfRequest<{ data: Instance[] }>("/api/instances");
}

export async function getPublicStatus() {
  return selfRequest<{ data: PublicStatus }>("/api/public/status");
}

export async function getAuthState() {
  return selfRequest<{ data: AuthState }>("/api/auth/state");
}

export async function loginAdmin(input: AdminLogin) {
  return selfRequest<{ data: AuthState }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function logoutAdmin() {
  return selfRequest<{ data: AuthState }>("/api/auth/logout", {
    method: "POST",
  });
}

export async function listInstanceHealthSummaries() {
  return request<{ data: InstanceHealthSummary[] }>(
    "/api/instances/health-summary",
  );
}
