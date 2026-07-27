import type {
  ModelPresetCreate,
  ModelPresetDocument,
  ModelPresetSummary,
  ModelPresetWrite,
} from "@arriero/core";

import { activeNodeScopedPath, apiBase } from "./base.js";
import { nodeRequest as request } from "./http.js";

export async function listPresets() {
  return request<{ data: ModelPresetSummary[] }>("/api/presets");
}

export async function getPreset(name: string) {
  return request<{ data: ModelPresetDocument }>(
    `/api/presets/${encodeURIComponent(name)}`,
  );
}

export async function createPreset(input: ModelPresetCreate) {
  return request<{ data: ModelPresetDocument }>("/api/presets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type SavePresetResult =
  | { kind: "ok"; document: ModelPresetDocument }
  | { kind: "conflict"; document: ModelPresetDocument };

export async function savePreset(
  name: string,
  input: ModelPresetWrite,
): Promise<SavePresetResult> {
  const response = await fetch(
    `${apiBase}${activeNodeScopedPath(`/api/presets/${encodeURIComponent(name)}`)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    },
  );
  const body = (await response.json()) as {
    data?: ModelPresetDocument;
    error?: unknown;
  };
  if (response.status === 409 && body.data) {
    return { kind: "conflict", document: body.data };
  }
  if (!response.ok || !body.data) {
    throw new Error(
      typeof body.error === "string" ? body.error : "failed to save preset",
    );
  }
  return { kind: "ok", document: body.data };
}
