import { createHash } from "node:crypto";

const volatileBodyKeys = new Set(["stream", "stream_options"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function withoutVolatileKeys(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (volatileBodyKeys.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function apiProxyResponseCacheKey(input: {
  namespace: string;
  modelId: string;
  body: unknown;
}): string {
  const payload = JSON.stringify({
    version: 2,
    namespace: input.namespace,
    modelId: input.modelId,
    body: canonicalize(withoutVolatileKeys(input.body)),
  });
  return createHash("sha256").update(payload).digest("hex");
}
