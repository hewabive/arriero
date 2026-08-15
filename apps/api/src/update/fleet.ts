import {
  AppVersionSchema,
  type AppVersion,
  type UpdateFleet,
  type UpdateFleetNode,
  type UpdateUpstream,
} from "@arriero/core";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

import { listNodes } from "../nodes/repository.js";
import { fetchNodeJson } from "../nodes/remote.js";
import { updateAdapter } from "./adapter.js";
import { appVersionWithStartedAt } from "./restart.js";

function tryGit(args: string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd: updateAdapter.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
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
  const count = tryGit(["rev-list", "--count", `${commit}..${upstreamCommit}`]);
  const parsed = count !== null ? Number(count) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
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
  const selfVersion = appVersionWithStartedAt();
  const upstream = currentUpstream(selfVersion);
  const upstreamCommit = upstream?.commit ?? null;

  const self = nodeEntry(
    { nodeId: "self", nodeName: hostname(), self: true, baseUrl: null },
    selfVersion,
    null,
    upstreamCommit,
  );

  const peers = await Promise.all(
    listNodes().map(async (node) => {
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
