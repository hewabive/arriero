import { newId } from "../utils/id.js";
import { sanitizeClaudeCodeAttribution } from "./attribution.js";
import { apiProxyForwardUrl } from "./forwarder.js";
import { proxyUpstreamFetch } from "./http.js";
import { apiProxyResponseCacheKey } from "./response-cache-key.js";

export type ApiProxyStreamSessionEntry = {
  inflightId: string;
  convId: string;
  instanceId: string;
  targetId: string;
  modelId: string;
  baseUrl: string;
  authHeaders: Record<string, string>;
  resumeKey: string;
  protocol: "openai" | "anthropic";
  endpoint: string;
  stream: boolean;
  startedAt: string;
};

export type ApiProxyStreamSessionInput = Omit<
  ApiProxyStreamSessionEntry,
  "convId" | "startedAt"
>;

type StreamSessionFetch = (url: string, init: RequestInit) => Promise<Response>;

type ApiProxyStreamSessionRegistryOptions = {
  fetchImpl?: StreamSessionFetch;
  now?: () => string;
};

export class ApiProxyStreamSessionRegistry {
  private readonly entries = new Map<string, ApiProxyStreamSessionEntry>();
  private readonly fetchImpl: StreamSessionFetch;
  private readonly now: () => string;
  private persisting = false;

  constructor(options: ApiProxyStreamSessionRegistryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? proxyUpstreamFetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  register(input: ApiProxyStreamSessionInput): ApiProxyStreamSessionEntry {
    const entry: ApiProxyStreamSessionEntry = {
      ...input,
      convId: newId(),
      startedAt: this.now(),
    };
    this.entries.set(entry.inflightId, entry);
    return entry;
  }

  release(inflightId: string): void {
    const entry = this.entries.get(inflightId);
    if (!entry) {
      return;
    }
    this.entries.delete(inflightId);
    if (this.persisting) {
      return;
    }
    this.evict(entry);
  }

  beginPersist(): ApiProxyStreamSessionEntry[] {
    this.persisting = true;
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
    this.persisting = false;
  }

  private evict(entry: ApiProxyStreamSessionEntry): void {
    const url = apiProxyForwardUrl(entry.baseUrl, `/v1/stream/${entry.convId}`);
    void this.fetchImpl(url, {
      method: "DELETE",
      headers: entry.authHeaders,
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
}

export const apiProxyStreamSessions = new ApiProxyStreamSessionRegistry();

export function apiProxyStreamResumeKey(input: {
  instanceId: string;
  path: string;
  modelId: string;
  body: unknown;
}): string {
  return apiProxyResponseCacheKey({
    namespace: `stream-resume:${input.instanceId}:${input.path}`,
    modelId: input.modelId,
    body: sanitizeClaudeCodeAttribution(input.body),
  });
}
