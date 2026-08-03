import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { apiProxyForwardUrl } from "./forwarder.js";
import { proxyUpstreamFetch } from "./http.js";
import {
  apiProxyStreamSessionUrl,
  type ApiProxyStreamSessionEntry,
} from "./stream-session.js";

const PENDING_RESUME_FILE = resolve(
  config.dataDir,
  "proxy-pending-resume.json",
);

const PendingResumeEntrySchema = z.object({
  convId: z.string(),
  instanceId: z.string(),
  targetId: z.string(),
  modelId: z.string(),
  baseUrl: z.string(),
  authHeaders: z.record(z.string(), z.string()),
  resumeKey: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  endpoint: z.string(),
  stream: z.boolean(),
  startedAt: z.string(),
});

const PendingResumeFileSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  entries: z.array(PendingResumeEntrySchema),
});

export type ApiProxyPendingResumeEntry = z.infer<
  typeof PendingResumeEntrySchema
>;

type PendingRecord = {
  entry: ApiProxyPendingResumeEntry;
  expiresAt: number;
};

type PendingResumeFetch = (url: string, init: RequestInit) => Promise<Response>;

type ApiProxyPendingResumeStoreOptions = {
  file?: string;
  fetchImpl?: PendingResumeFetch;
  now?: () => number;
  claimWindowMs?: number;
};

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export class ApiProxyPendingResumeStore {
  private pending: PendingRecord[] = [];
  private readonly claimed = new Map<string, ApiProxyPendingResumeEntry>();
  private readonly file: string;
  private readonly fetchImpl: PendingResumeFetch;
  private readonly now: () => number;
  private readonly claimWindowMs: number;

  constructor(options: ApiProxyPendingResumeStoreOptions = {}) {
    this.file = options.file ?? PENDING_RESUME_FILE;
    this.fetchImpl = options.fetchImpl ?? proxyUpstreamFetch;
    this.now = options.now ?? (() => Date.now());
    this.claimWindowMs =
      options.claimWindowMs ?? config.proxy.resumeClaimWindowMs;
  }

  persist(sessions: ApiProxyStreamSessionEntry[]): number {
    const entries = sessions.map((session) =>
      PendingResumeEntrySchema.parse({
        convId: session.convId,
        instanceId: session.instanceId,
        targetId: session.targetId,
        modelId: session.modelId,
        baseUrl: session.baseUrl,
        authHeaders: session.authHeaders,
        resumeKey: session.resumeKey,
        protocol: session.protocol,
        endpoint: session.endpoint,
        stream: session.stream,
        startedAt: session.startedAt,
      }),
    );
    if (entries.length === 0) {
      rmSync(this.file, { force: true });
      return 0;
    }
    atomicWrite(
      this.file,
      `${JSON.stringify(
        {
          version: 1,
          savedAt: new Date(this.now()).toISOString(),
          entries,
        },
        null,
        2,
      )}\n`,
    );
    return entries.length;
  }

  adopt(): { adopted: number; verified: Promise<void> } {
    if (!existsSync(this.file)) {
      return { adopted: 0, verified: Promise.resolve() };
    }
    let parsed: z.infer<typeof PendingResumeFileSchema> | null = null;
    try {
      const result = PendingResumeFileSchema.safeParse(
        JSON.parse(readFileSync(this.file, "utf8")),
      );
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    rmSync(this.file, { force: true });
    if (!parsed || parsed.entries.length === 0) {
      return { adopted: 0, verified: Promise.resolve() };
    }
    const expiresAt = this.now() + this.claimWindowMs;
    this.pending = parsed.entries.map((entry) => ({ entry, expiresAt }));
    return {
      adopted: this.pending.length,
      verified: this.verifyPending(),
    };
  }

  claim(resumeKey: string): ApiProxyPendingResumeEntry | null {
    const index = this.pending.findIndex(
      (record) => record.entry.resumeKey === resumeKey,
    );
    if (index === -1) {
      return null;
    }
    const [record] = this.pending.splice(index, 1);
    const entry = record!.entry;
    this.claimed.set(entry.convId, entry);
    return entry;
  }

  finish(entry: ApiProxyPendingResumeEntry, options: { evict: boolean }): void {
    this.claimed.delete(entry.convId);
    if (options.evict) {
      this.deleteSession(entry);
    }
  }

  sweep(): number {
    const at = this.now();
    const expired = this.pending.filter((record) => record.expiresAt <= at);
    if (expired.length === 0) {
      return 0;
    }
    this.pending = this.pending.filter((record) => record.expiresAt > at);
    for (const record of expired) {
      this.deleteSession(record.entry);
    }
    return expired.length;
  }

  targetIds(): string[] {
    const ids = new Set<string>();
    for (const record of this.pending) {
      ids.add(record.entry.targetId);
    }
    for (const entry of this.claimed.values()) {
      ids.add(entry.targetId);
    }
    return [...ids];
  }

  size(): number {
    return this.pending.length + this.claimed.size;
  }

  reset(): void {
    this.pending = [];
    this.claimed.clear();
  }

  private async verifyPending(): Promise<void> {
    const byBaseUrl = new Map<string, ApiProxyPendingResumeEntry[]>();
    for (const record of this.pending) {
      const bucket = byBaseUrl.get(record.entry.baseUrl) ?? [];
      bucket.push(record.entry);
      byBaseUrl.set(record.entry.baseUrl, bucket);
    }
    await Promise.all(
      [...byBaseUrl.entries()].map(async ([baseUrl, entries]) => {
        const alive = await this.lookupSessions(baseUrl, entries);
        if (alive === null) {
          this.drop(entries.map((entry) => entry.convId));
          return;
        }
        this.drop(
          entries
            .filter((entry) => !alive.has(entry.convId))
            .map((entry) => entry.convId),
        );
      }),
    );
  }

  private async lookupSessions(
    baseUrl: string,
    entries: ApiProxyPendingResumeEntry[],
  ): Promise<Set<string> | null> {
    const url = apiProxyForwardUrl(baseUrl, "/v1/streams/lookup");
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...entries[0]!.authHeaders,
        },
        body: JSON.stringify({
          conversation_ids: entries.map((entry) => entry.convId),
        }),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) {
        return null;
      }
      const alive = new Set<string>();
      for (const item of body) {
        const convId = (item as { conversation_id?: unknown }).conversation_id;
        if (typeof convId === "string") {
          alive.add(convId);
        }
      }
      return alive;
    } catch {
      return null;
    }
  }

  private drop(convIds: string[]): void {
    if (convIds.length === 0) {
      return;
    }
    const gone = new Set(convIds);
    this.pending = this.pending.filter(
      (record) => !gone.has(record.entry.convId),
    );
  }

  private deleteSession(entry: ApiProxyPendingResumeEntry): void {
    const url = apiProxyStreamSessionUrl({
      baseUrl: entry.baseUrl,
      convId: entry.convId,
    });
    void this.fetchImpl(url, {
      method: "DELETE",
      headers: entry.authHeaders,
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
}

export const apiProxyPendingResume = new ApiProxyPendingResumeStore();
