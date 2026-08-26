import {
  AppVersionSchema,
  type AppVersion,
  type UpdateFleet,
  type UpdateFleetNode,
  type UpdateUpstream,
} from "@arriero/core";
import { hostname } from "node:os";

import { tryGitSync } from "../git/process.js";
import { listPeerNodes } from "../nodes/repository.js";
import { fetchNodeJson } from "../nodes/remote.js";
import { updateAdapter } from "./adapter.js";
import { appVersionWithRuntimeInfo } from "./restart.js";

const APP_VERSION_TTL_MS = 30_000;
const COMMITS_BEHIND_CACHE_LIMIT = 256;

let appVersionCache: { value: AppVersion; expiresAt: number } | null = null;
const commitsBehindCache = new Map<string, number>();

function tryGit(args: string[]): string | null {
  return tryGitSync(updateAdapter.rootDir, args);
}

function cachedAppVersion(): AppVersion {
  const now = Date.now();
  if (appVersionCache && appVersionCache.expiresAt > now) {
    return appVersionCache.value;
  }
  const value = appVersionWithRuntimeInfo();
  appVersionCache = { value, expiresAt: now + APP_VERSION_TTL_MS };
  return value;
}

function currentUpstream(version: AppVersion): UpdateUpstream | null {
  if (!version.upstreamCommit || !version.lastCheckedAt) {
    return null;
  }
  const commit = version.upstreamCommit;
  return {
    commit,
    shortCommit: commit.slice(0, 7),
    committedAt: tryGit(["log", "-1", "--format=%cI", commit]),
    ref: tryGit(["rev-parse", "--abbrev-ref", "@{u}"]),
    lastCheckedAt: version.lastCheckedAt,
  };
}

function commitsBehind(
  commit: string | null,
  upstreamCommit: string | null,
): number | null {
  if (!commit || !upstreamCommit) {
    return null;
  }
  if (commit === upstreamCommit) {
    return 0;
  }
  const range = `${commit}..${upstreamCommit}`;
  const cached = commitsBehindCache.get(range);
  if (cached !== undefined) {
    return cached;
  }
  const count = tryGit(["rev-list", "--count", range]);
  const parsed = count !== null ? Number(count) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (commitsBehindCache.size >= COMMITS_BEHIND_CACHE_LIMIT) {
    commitsBehindCache.clear();
  }
  commitsBehindCache.set(range, parsed);
  return parsed;
}

function nodeEntry(
  base: Pick<UpdateFleetNode, "nodeId" | "nodeName" | "self" | "baseUrl">,
  version: AppVersion | null,
  error: string | null,
  upstreamCommit: string | null,
): UpdateFleetNode {
  const commit = version?.commit ?? null;
  const behindCount = version ? commitsBehind(commit, upstreamCommit) : null;
  const outdated =
    behindCount !== null
      ? behindCount > 0
      : Boolean(upstreamCommit && commit && commit !== upstreamCommit);
  return {
    ...base,
    ok: version !== null,
    error,
    version,
    outdated,
    behindCount,
  };
}

export async function updateFleet(): Promise<UpdateFleet> {
  const selfVersion = cachedAppVersion();
  const upstream = currentUpstream(selfVersion);
  const upstreamCommit = upstream?.commit ?? null;

  const self = nodeEntry(
    { nodeId: "self", nodeName: hostname(), self: true, baseUrl: null },
    selfVersion,
    null,
    upstreamCommit,
  );

  const peers = await Promise.all(
    listPeerNodes().map(async (node) => {
      const base = {
        nodeId: node.id,
        nodeName: node.name,
        self: false,
        baseUrl: node.baseUrl,
      };
      if (!node.enabled) {
        return nodeEntry(base, null, "node is disabled", upstreamCommit);
      }
      try {
        const raw = await fetchNodeJson<unknown>(node, "version");
        return nodeEntry(
          base,
          AppVersionSchema.parse(raw),
          null,
          upstreamCommit,
        );
      } catch (error) {
        return nodeEntry(base, null, (error as Error).message, upstreamCommit);
      }
    }),
  );

  return { upstream, nodes: [self, ...peers] };
}
