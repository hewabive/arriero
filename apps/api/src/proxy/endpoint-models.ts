import type { ApiEndpointRecord } from "@arriero/core";

import { apiEndpointAuthHeaders } from "./endpoints.js";

type CacheEntry = { ids: string[]; fetchedAt: number };

const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string[]>>();

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of data) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string"
    ) {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

async function fetchEndpointModelIds(
  endpoint: ApiEndpointRecord,
): Promise<string[]> {
  const auth = apiEndpointAuthHeaders(endpoint.id);
  if (!auth.ok) {
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(modelsUrl(endpoint.baseUrl), {
      headers: { ...auth.headers, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }
    return parseModelIds((await response.json()) as unknown);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function getCachedEndpointModelIds(endpointId: string): string[] | null {
  return cache.get(endpointId)?.ids ?? null;
}

export async function getEndpointModelIds(
  endpoint: ApiEndpointRecord,
): Promise<string[]> {
  const cached = cache.get(endpoint.id);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.ids;
  }
  let pending = inflight.get(endpoint.id);
  if (!pending) {
    pending = fetchEndpointModelIds(endpoint).then((ids) => {
      cache.set(endpoint.id, { ids, fetchedAt: Date.now() });
      inflight.delete(endpoint.id);
      return ids;
    });
    inflight.set(endpoint.id, pending);
  }
  return pending;
}
