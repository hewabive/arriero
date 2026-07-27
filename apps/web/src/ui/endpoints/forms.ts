import type { ApiEndpointCreate, ApiEndpointRecord } from "@arriero/core";

export type EndpointEditor =
  | { mode: "create"; endpoint: null }
  | { mode: "edit"; endpoint: ApiEndpointRecord };

export type EndpointHeaderDraft = { name: string; value: string };

export type EndpointDraft = {
  name: string;
  enabled: boolean;
  baseUrl: string;
  profile: "openai" | "llama-native" | "anthropic";
  apiKey: string;
  apiKeyEnvVar: string;
  authHeaderName: string;
  extraHeaders: EndpointHeaderDraft[];
  passthrough: boolean;
  allowPatterns: string;
  denyPatterns: string;
};

export const emptyEndpointDraft: EndpointDraft = {
  name: "",
  enabled: true,
  baseUrl: "",
  profile: "openai",
  apiKey: "",
  apiKeyEnvVar: "",
  authHeaderName: "",
  extraHeaders: [],
  passthrough: false,
  allowPatterns: "",
  denyPatterns: "",
};

function parsePatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatPatterns(list: readonly string[] | undefined): string {
  return (list ?? []).join("\n");
}

export function endpointDraftFromRecord(
  endpoint: ApiEndpointRecord,
): EndpointDraft {
  return {
    name: endpoint.name,
    enabled: endpoint.enabled,
    baseUrl: endpoint.baseUrl,
    profile: endpoint.profile,
    apiKey: "",
    apiKeyEnvVar: endpoint.apiKeyEnvVar ?? "",
    authHeaderName: endpoint.authHeaderName ?? "",
    extraHeaders: Object.entries(endpoint.extraHeaders).map(
      ([name, value]) => ({
        name,
        value,
      }),
    ),
    passthrough: endpoint.passthrough,
    allowPatterns: formatPatterns(endpoint.modelFilter?.allow),
    denyPatterns: formatPatterns(endpoint.modelFilter?.deny),
  };
}

export function endpointPayload(draft: EndpointDraft): ApiEndpointCreate {
  const envVar = draft.apiKeyEnvVar.trim();
  const apiKey = draft.apiKey.trim();

  const extraHeaders: Record<string, string> = {};
  for (const header of draft.extraHeaders) {
    const name = header.name.trim();
    if (name) {
      extraHeaders[name] = header.value;
    }
  }

  const allow = parsePatterns(draft.allowPatterns);
  const deny = parsePatterns(draft.denyPatterns);
  const modelFilter =
    allow.length || deny.length
      ? {
          ...(allow.length ? { allow } : {}),
          ...(deny.length ? { deny } : {}),
        }
      : null;

  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    baseUrl: draft.baseUrl.trim(),
    profile: draft.profile,
    apiKeyEnvVar: envVar || null,
    authHeaderName: draft.authHeaderName.trim() || null,
    extraHeaders,
    passthrough: draft.passthrough,
    modelFilter,
    ...(apiKey && !envVar ? { apiKey } : {}),
  };
}
