import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  LlamaSourceSyncReport,
  SourceSyncDivergence,
  SourceSyncSection,
} from "@arriero/core";
import { RPC_SERVER_SUPPORTED_FLAGS } from "@arriero/core";

import {
  generatedHelpChangedLines,
  getLlamaArgumentHelpSourceSync,
} from "../arguments/docs-source.js";
import { LLAMA_CPP_SOURCE_ID } from "../sources/registry.js";
import { getSourceRepositoryStatus } from "../sources/repository.js";
import { capabilityDefinitions } from "./probe.js";

const serverSourceCandidates = [
  "tools/server/server.cpp",
  "examples/server/server.cpp",
];

const probeEndpointAliases: Record<string, string[]> = {
  "/v1/models": ["/models"],
  "/v1/chat/completions": ["/chat/completions"],
  "/v1/completions": ["/completions", "/completion"],
  "/v1/responses": ["/responses"],
  "/v1/embeddings": ["/embeddings", "/embedding"],
  "/v1/rerank": ["/rerank", "/reranking", "/v1/reranking"],
  "/health": ["/v1/health"],
  "/v1/audio/transcriptions": ["/audio/transcriptions"],
  "/v1/chat/completions/input_tokens": ["/chat/completions/input_tokens"],
  "/v1/responses/input_tokens": ["/responses/input_tokens"],
};

const ignoredEndpoints = new Map<string, string>([
  ["/cors-proxy", "Web UI CORS proxy, not a model capability"],
  ["/tools", "Web UI helper route"],
  ["/v1/chat/completions/control", "Router-mode control channel"],
  ["/chat/completions/control", "Router-mode control channel"],
  ["/models/load", "Router model management (handled separately)"],
  ["/models/unload", "Router model management (handled separately)"],
  ["/models/sse", "Router model-state event stream (handled separately)"],
  ["/slots/:id_slot", "Slot cache save/restore/erase, handled by slot actions"],
  ["/v1/stream", "SSE replay of a session probed via /v1/streams/lookup"],
  ["/v1/audio/speech", "Text-to-speech, requires a dedicated talker model"],
  ["/audio/speech", "Text-to-speech, requires a dedicated talker model"],
]);

type SourceRoute = { method: "GET" | "POST"; path: string };

function aliasesFor(endpoint: string): string[] {
  return [endpoint, ...(probeEndpointAliases[endpoint] ?? [])];
}

function serverSourcePath(repoPath: string): string | null {
  for (const candidate of serverSourceCandidates) {
    const full = resolve(repoPath, candidate);
    if (existsSync(full)) {
      return full;
    }
  }
  return null;
}

function parseServerRoutes(source: string): SourceRoute[] {
  const pattern = /ctx_http\.(get|post)\s*\(\s*"(\/[^"]*)"/g;
  const seen = new Set<string>();
  const routes: SourceRoute[] = [];
  for (const match of source.matchAll(pattern)) {
    const method = match[1]!.toUpperCase() as "GET" | "POST";
    const path = match[2]!;
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path });
  }
  return routes;
}

function methodsByPath(routes: SourceRoute[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const route of routes) {
    const methods = map.get(route.path) ?? new Set<string>();
    methods.add(route.method);
    map.set(route.path, methods);
  }
  return map;
}

function reconcileCapabilityEndpoints(repoPath: string): SourceSyncSection {
  const base: Omit<SourceSyncSection, "status" | "summary" | "error"> & {
    sourcePath: string;
  } = {
    id: "capability-endpoints",
    title: "Capability endpoints",
    description:
      "llama-server HTTP routes vs the Diagnostics capability probe set.",
    sourcePath: serverSourceCandidates[0]!,
    divergences: [],
  };

  const sourceFile = serverSourcePath(repoPath);
  if (!sourceFile) {
    return {
      ...base,
      status: "error",
      summary: "llama-server source not found in the configured checkout.",
      error: `Server source not found (looked for ${serverSourceCandidates.join(", ")} under ${repoPath}).`,
      divergences: [],
    };
  }

  let routes: SourceRoute[];
  try {
    routes = parseServerRoutes(readFileSync(sourceFile, "utf8"));
  } catch (error) {
    return {
      ...base,
      status: "error",
      summary: "Failed to read llama-server source.",
      error: (error as Error).message,
      divergences: [],
    };
  }

  if (routes.length === 0) {
    return {
      ...base,
      status: "error",
      summary: "No ctx_http routes parsed from the server source.",
      error:
        "Route registration pattern matched nothing — the parser may be out of date with llama.cpp.",
      divergences: [],
    };
  }

  const coveredPaths = new Set(
    capabilityDefinitions.flatMap((definition) =>
      aliasesFor(definition.endpoint),
    ),
  );
  const sourcePaths = new Set(routes.map((route) => route.path));
  const pathMethods = methodsByPath(routes);

  const divergences: SourceSyncDivergence[] = [];

  for (const [path, methods] of [...pathMethods.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (coveredPaths.has(path) || ignoredEndpoints.has(path)) continue;
    divergences.push({
      kind: "unprobed",
      severity: "warning",
      label: `${[...methods].sort().join("/")} ${path}`,
      detail: "Registered in llama.cpp but not in the capability probe set.",
    });
  }

  for (const definition of capabilityDefinitions) {
    const present = aliasesFor(definition.endpoint).some((alias) =>
      sourcePaths.has(alias),
    );
    if (present) continue;
    divergences.push({
      kind: "stale",
      severity: "warning",
      label: `${definition.method} ${definition.endpoint} (${definition.id})`,
      detail: "Probed capability is no longer registered in llama.cpp.",
    });
  }

  const unprobed = divergences.filter(
    (item) => item.kind === "unprobed",
  ).length;
  const stale = divergences.filter((item) => item.kind === "stale").length;

  return {
    ...base,
    status: divergences.length === 0 ? "in-sync" : "drift",
    summary:
      divergences.length === 0
        ? `All ${routes.length} routes are covered or intentionally ignored.`
        : `${unprobed} unprobed route(s), ${stale} stale probe(s) across ${routes.length} routes.`,
    error: null,
    divergences,
  };
}

const rpcServerSourceCandidates = [
  "tools/rpc/rpc-server.cpp",
  "examples/rpc/rpc-server.cpp",
];

const ignoredRpcServerFlags = new Set(["--help", "-h"]);

export type RpcServerUsageFlag = {
  long: string | null;
  short: string | null;
  label: string;
};

function rpcServerSourcePath(repoPath: string): string | null {
  for (const candidate of rpcServerSourceCandidates) {
    const full = resolve(repoPath, candidate);
    if (existsSync(full)) {
      return full;
    }
  }
  return null;
}

export function parseRpcServerUsageFlags(source: string): RpcServerUsageFlag[] {
  const start = source.indexOf("static void print_usage");
  if (start === -1) {
    return [];
  }
  const end = source.indexOf("\n}", start);
  const block = end === -1 ? source.slice(start) : source.slice(start, end);

  const flags: RpcServerUsageFlag[] = [];
  const stringLiteral = /"((?:\\.|[^"\\])*)"/;
  for (const line of block.split("\n")) {
    const match = line.match(stringLiteral);
    if (!match) continue;
    const content = match[1]!.replace(/^\s+/, "");
    if (!content.startsWith("-")) continue;
    const head = content.split(/\s{2,}/)[0] ?? "";
    const tokens = head.match(/-{1,2}[A-Za-z][\w-]*/g) ?? [];
    if (tokens.length === 0) continue;
    flags.push({
      long: tokens.find((token) => token.startsWith("--")) ?? null,
      short: tokens.find((token) => /^-[A-Za-z]$/.test(token)) ?? null,
      label: head.trim(),
    });
  }
  return flags;
}

export function rpcServerFlagDivergences(
  sourceFlags: RpcServerUsageFlag[],
): SourceSyncDivergence[] {
  const supportedByLong = new Map(
    RPC_SERVER_SUPPORTED_FLAGS.map((flag) => [flag.long, flag]),
  );
  const sourceLongFlags = new Set(
    sourceFlags
      .map((flag) => flag.long)
      .filter((long): long is string => long !== null),
  );

  const divergences: SourceSyncDivergence[] = [];

  for (const flag of [...sourceFlags].sort((a, b) =>
    (a.long ?? a.short ?? "").localeCompare(b.long ?? b.short ?? ""),
  )) {
    if (flag.long && ignoredRpcServerFlags.has(flag.long)) continue;
    if (flag.short && ignoredRpcServerFlags.has(flag.short)) continue;
    if (flag.long && supportedByLong.has(flag.long)) continue;
    divergences.push({
      kind: "unprobed",
      severity: "warning",
      label: flag.label,
      detail:
        "Exposed by rpc-server but not handled by the rpc-worker settings form.",
    });
  }

  for (const flag of RPC_SERVER_SUPPORTED_FLAGS) {
    if (sourceLongFlags.has(flag.long)) continue;
    divergences.push({
      kind: "stale",
      severity: "warning",
      label: `${flag.short}, ${flag.long}`,
      detail:
        "Sent by the rpc-worker form but no longer accepted by rpc-server.",
    });
  }

  return divergences;
}

function reconcileRpcServerFlags(repoPath: string): SourceSyncSection {
  const base = {
    id: "rpc-server-flags",
    title: "RPC server flags",
    description:
      "rpc-server CLI flags vs the rpc-worker settings form's known flags.",
    sourcePath: rpcServerSourceCandidates[0]!,
    divergences: [] as SourceSyncDivergence[],
  };

  const sourceFile = rpcServerSourcePath(repoPath);
  if (!sourceFile) {
    return {
      ...base,
      status: "error",
      summary: "rpc-server source not found in the configured checkout.",
      error: `rpc-server source not found (looked for ${rpcServerSourceCandidates.join(", ")} under ${repoPath}).`,
    };
  }

  let flags: RpcServerUsageFlag[];
  try {
    flags = parseRpcServerUsageFlags(readFileSync(sourceFile, "utf8"));
  } catch (error) {
    return {
      ...base,
      status: "error",
      summary: "Failed to read rpc-server source.",
      error: (error as Error).message,
    };
  }

  if (flags.length === 0) {
    return {
      ...base,
      status: "error",
      summary: "No flags parsed from print_usage in rpc-server.cpp.",
      error:
        "The print_usage parser matched nothing — it may be out of date with llama.cpp.",
    };
  }

  const divergences = rpcServerFlagDivergences(flags);
  const unprobed = divergences.filter(
    (item) => item.kind === "unprobed",
  ).length;
  const stale = divergences.filter((item) => item.kind === "stale").length;

  return {
    ...base,
    status: divergences.length === 0 ? "in-sync" : "drift",
    summary:
      divergences.length === 0
        ? `All ${flags.length} rpc-server flag(s) are covered or intentionally ignored.`
        : `${unprobed} unhandled flag(s), ${stale} stale flag(s) across ${flags.length} rpc-server flags.`,
    error: null,
    divergences,
  };
}

function reconcileArgumentHelp(): SourceSyncSection {
  const base = {
    id: "argument-help",
    title: "llama-server argument help",
    description:
      "Stored argument help snapshot vs the llama.cpp tools/server/README.md HELP block.",
    sourcePath: "tools/server/README.md",
    divergences: [] as SourceSyncDivergence[],
  };

  const help = getLlamaArgumentHelpSourceSync();
  const sourceError = help.current.error ?? help.stored.error;

  if (sourceError || help.inSync === null) {
    return {
      ...base,
      status: "error",
      summary:
        "Could not compare the stored argument help snapshot with llama.cpp.",
      error: sourceError ?? "Argument help snapshot or source is unavailable.",
    };
  }

  if (help.inSync) {
    return {
      ...base,
      status: "in-sync",
      summary: "Argument help matches the llama.cpp source.",
      error: null,
    };
  }

  let added = 0;
  let removed = 0;
  try {
    for (const line of generatedHelpChangedLines().split("\n")) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  } catch {
    added = 0;
    removed = 0;
  }

  return {
    ...base,
    status: "drift",
    summary: `Argument help differs from llama.cpp (${added} added, ${removed} removed line(s)).`,
    error: null,
  };
}

export async function getLlamaSourceSyncReport(): Promise<LlamaSourceSyncReport> {
  const repository = await getSourceRepositoryStatus(LLAMA_CPP_SOURCE_ID);
  const repoPath = repository.repoPath;
  if (!repository.valid || repository.state === "busy") {
    return {
      sourceId: LLAMA_CPP_SOURCE_ID,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      repository,
      repoPath,
      commit: null,
      llamaCppCommit: null,
      sections: [],
    };
  }
  const sections = [
    reconcileCapabilityEndpoints(repoPath),
    reconcileRpcServerFlags(repoPath),
    reconcileArgumentHelp(),
  ];
  const status = sections.some((section) => section.status === "error")
    ? "error"
    : sections.some((section) => section.status === "drift")
      ? "drift"
      : "in-sync";
  return {
    sourceId: LLAMA_CPP_SOURCE_ID,
    status,
    checkedAt: new Date().toISOString(),
    repository,
    repoPath,
    commit: repository.currentCommit,
    llamaCppCommit: repository.currentCommit,
    sections,
  };
}
