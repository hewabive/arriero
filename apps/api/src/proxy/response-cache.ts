import type Database from "better-sqlite3";
import { sqlite } from "../db/index.js";

export type ApiProxyCachedResponse = {
  status: number;
  contentType: string;
  isSse: boolean;
  body: string;
};

const maxTotalBytes = 512 * 1024 * 1024;

function lazyStatement(sql: string): () => Database.Statement {
  let statement: Database.Statement | undefined;
  return () => (statement ??= sqlite.prepare(sql));
}

const selectStatement = lazyStatement(
  `SELECT status, content_type AS contentType, is_sse AS isSse, body, expires_at AS expiresAt
     FROM proxy_response_cache WHERE key = ?`,
);
const touchStatement = lazyStatement(
  `UPDATE proxy_response_cache SET last_access_at = ?, hit_count = hit_count + 1 WHERE key = ?`,
);
const deleteStatement = lazyStatement(
  `DELETE FROM proxy_response_cache WHERE key = ?`,
);
const upsertStatement = lazyStatement(
  `INSERT INTO proxy_response_cache
     (key, model_id, status, content_type, is_sse, body, size_bytes, created_at, expires_at, last_access_at, hit_count)
   VALUES (@key, @modelId, @status, @contentType, @isSse, @body, @sizeBytes, @createdAt, @expiresAt, @lastAccessAt, 0)
   ON CONFLICT(key) DO UPDATE SET
     model_id = excluded.model_id,
     status = excluded.status,
     content_type = excluded.content_type,
     is_sse = excluded.is_sse,
     body = excluded.body,
     size_bytes = excluded.size_bytes,
     created_at = excluded.created_at,
     expires_at = excluded.expires_at,
     last_access_at = excluded.last_access_at,
     hit_count = 0`,
);
const totalBytesStatement = lazyStatement(
  `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM proxy_response_cache`,
);
const evictExpiredStatement = lazyStatement(
  `DELETE FROM proxy_response_cache WHERE expires_at IS NOT NULL AND expires_at <= ?`,
);
const lruStatement = lazyStatement(
  `SELECT key, size_bytes AS sizeBytes FROM proxy_response_cache ORDER BY last_access_at ASC`,
);
const clearStatement = lazyStatement(`DELETE FROM proxy_response_cache`);

export function getApiProxyCachedResponse(
  key: string,
): ApiProxyCachedResponse | null {
  const row = selectStatement().get(key) as
    | {
        status: number;
        contentType: string;
        isSse: number;
        body: string;
        expiresAt: number | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
    deleteStatement().run(key);
    return null;
  }
  touchStatement().run(Date.now(), key);
  return {
    status: row.status,
    contentType: row.contentType,
    isSse: row.isSse === 1,
    body: row.body,
  };
}

export function putApiProxyCachedResponse(input: {
  key: string;
  modelId: string;
  status: number;
  contentType: string;
  isSse: boolean;
  body: string;
  ttlSeconds: number;
}): void {
  const now = Date.now();
  const sizeBytes = Buffer.byteLength(input.body, "utf8");
  upsertStatement().run({
    key: input.key,
    modelId: input.modelId,
    status: input.status,
    contentType: input.contentType,
    isSse: input.isSse ? 1 : 0,
    body: input.body,
    sizeBytes,
    createdAt: now,
    expiresAt: input.ttlSeconds > 0 ? now + input.ttlSeconds * 1000 : null,
    lastAccessAt: now,
  });
  evictApiProxyResponseCache();
}

function evictApiProxyResponseCache(): void {
  evictExpiredStatement().run(Date.now());
  let total = (totalBytesStatement().get() as { total: number }).total;
  if (total <= maxTotalBytes) {
    return;
  }
  const rows = lruStatement().all() as Array<{
    key: string;
    sizeBytes: number;
  }>;
  for (const row of rows) {
    if (total <= maxTotalBytes) {
      break;
    }
    deleteStatement().run(row.key);
    total -= row.sizeBytes;
  }
}

export function clearApiProxyResponseCache(): void {
  clearStatement().run();
}

const statsStatement = lazyStatement(
  `SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS totalBytes FROM proxy_response_cache`,
);

export function apiProxyResponseCacheStats(): {
  entries: number;
  totalBytes: number;
} {
  const row = statsStatement().get() as { entries: number; totalBytes: number };
  return { entries: row.entries, totalBytes: row.totalBytes };
}
