import {
  ApiLabProbeProfileSchema,
  ApiLabProbeTargetRequestSchema,
  type ApiLabProbeProfile,
} from "@arriero/core";
import type { Hono } from "hono";

import {
  apiLabProbeTargetFromBaseUrl,
  requestApiLabProbeBaseUrl,
} from "../api-lab/probe.js";
import {
  isStreamingProbeKind,
  streamApiProbeTarget,
} from "../api-lab/stream.js";
import { listInstances } from "../instances/repository.js";
import { requestJsonProbe } from "../instances/endpoint.js";
import {
  apiEndpointAuthHeaders,
  getApiEndpointFromCatalog,
} from "../proxy/endpoints.js";
import { getApiProxySource, getApiProxySourceKey } from "../proxy/sources.js";
import {
  apiVersionBaseUrl,
  normalizeHttpBaseUrl,
  stripV1BaseUrl,
} from "../proxy/targets.js";

function normalizeApiLabBaseUrl(profile: ApiLabProbeProfile, value: string) {
  const baseUrl = normalizeHttpBaseUrl(value);
  if (profile === "llama-native") {
    return stripV1BaseUrl(baseUrl);
  }
  return apiVersionBaseUrl(baseUrl);
}

function parseApiLabProfile(value: string | undefined) {
  const parsed = ApiLabProbeProfileSchema.safeParse(value ?? "openai");
  if (!parsed.success) {
    throw new Error("profile must be openai, llama-native, or anthropic");
  }
  return parsed.data;
}

function apiLabProfileHeaders(
  profile: ApiLabProbeProfile,
): Record<string, string> {
  return profile === "anthropic" ? { "anthropic-version": "2023-06-01" } : {};
}

function apiKeyAuthHeaders(
  profile: ApiLabProbeProfile,
  key: string,
): Record<string, string> {
  return profile === "anthropic"
    ? { "x-api-key": key }
    : { authorization: `Bearer ${key}` };
}

function requireApiProxySourceKey(sourceId: string): string {
  const source = getApiProxySource(sourceId);
  if (!source) {
    throw new Error("request source not found");
  }
  const key = getApiProxySourceKey(sourceId);
  if (!key) {
    throw new Error(`request source has no API key: ${source.name}`);
  }
  return key;
}

function resolveApiLabEndpoint(input: {
  profile: ApiLabProbeProfile;
  baseUrl?: string | undefined;
  endpointId?: string | undefined;
  sourceId?: string | undefined;
  apiKey?: string | undefined;
}) {
  const profileHeaders = apiLabProfileHeaders(input.profile);
  const key =
    input.apiKey ??
    (input.sourceId ? requireApiProxySourceKey(input.sourceId) : null);
  const sourceHeaders = key ? apiKeyAuthHeaders(input.profile, key) : {};
  if (input.endpointId) {
    const endpoint = getApiEndpointFromCatalog(
      input.endpointId,
      listInstances(),
    );
    if (!endpoint) {
      throw new Error("API endpoint not found");
    }
    const auth = apiEndpointAuthHeaders(endpoint.id);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    return {
      baseUrl: normalizeApiLabBaseUrl(input.profile, endpoint.baseUrl),
      headers: { ...profileHeaders, ...auth.headers, ...sourceHeaders },
    };
  }

  if (!input.baseUrl) {
    throw new Error("baseUrl is required");
  }
  return {
    baseUrl: normalizeApiLabBaseUrl(input.profile, input.baseUrl),
    headers: { ...profileHeaders, ...sourceHeaders },
  };
}

export function registerLabRoutes(app: Hono) {
  app.get("/api/lab/models", async (c) => {
    const rawBaseUrl = c.req.query("baseUrl");
    const endpointId = c.req.query("endpointId");
    try {
      const profile = parseApiLabProfile(c.req.query("profile"));
      if (profile !== "openai") {
        return c.json(
          {
            error: "model discovery is only implemented for the OpenAI profile",
          },
          400,
        );
      }
      const target = resolveApiLabEndpoint({
        profile,
        baseUrl: rawBaseUrl,
        endpointId,
      });
      return c.json({
        data: await requestJsonProbe(`${target.baseUrl}/models`, {
          headers: target.headers,
          timeoutMs: 10_000,
        }),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/lab/probe", async (c) => {
    const parsed = ApiLabProbeTargetRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    try {
      const profile = parsed.data.profile;
      const target = resolveApiLabEndpoint({
        profile,
        baseUrl: parsed.data.baseUrl,
        endpointId: parsed.data.endpointId,
        sourceId: parsed.data.sourceId,
        apiKey: parsed.data.apiKey,
      });
      const data = await requestApiLabProbeBaseUrl(
        profile,
        target.baseUrl,
        parsed.data.probe,
        target.headers,
      );
      return c.json({ data });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/lab/probe/stream", async (c) => {
    const parsed = ApiLabProbeTargetRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (!isStreamingProbeKind(parsed.data.probe.kind)) {
      return c.json(
        { error: "streaming is only supported for generation probes" },
        400,
      );
    }

    let resolved: ReturnType<typeof resolveApiLabEndpoint>;
    let target: ReturnType<typeof apiLabProbeTargetFromBaseUrl>;
    try {
      resolved = resolveApiLabEndpoint({
        profile: parsed.data.profile,
        baseUrl: parsed.data.baseUrl,
        endpointId: parsed.data.endpointId,
        sourceId: parsed.data.sourceId,
        apiKey: parsed.data.apiKey,
      });
      target = apiLabProbeTargetFromBaseUrl(
        parsed.data.profile,
        resolved.baseUrl,
        parsed.data.probe,
        {
          stream: true,
        },
      );
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    return streamApiProbeTarget(c, {
      request: parsed.data.probe,
      headers: resolved.headers,
      target,
    });
  });
}
