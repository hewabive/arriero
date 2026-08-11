import {
  EngineHelpSourceSyncSchema,
  LLAMA_CPP_SOURCE_ID,
  type EngineArgumentExtract,
  type EngineHelpSourceSnapshot,
  type EngineHelpSourceSync,
} from "@arriero/core";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { config } from "../config.js";
import { isExactGitRepositorySync, tryGitSync } from "../git/process.js";
import { sourceRepositoryPath } from "../sources/repository.js";
import {
  generatedHelpDiff,
  getLlamaArgumentHelpSourceSync,
  updateStoredGeneratedHelpSnapshot,
} from "./docs-source.js";
import {
  diffEngineArgumentExtracts,
  engineArgumentSurfaceHash,
  normalizeHelpPayload,
  parseEngineArgumentExtract,
} from "./help-source.js";
import {
  runArgumentExtractor,
  type ExtractorRunner,
} from "./help-source-extract.js";

export type EngineHelpSourceAdapter = {
  id: string;
  displayName: string;
  sourceId: string;
  sourcePaths: string[];
  sync(): Promise<EngineHelpSourceSync>;
  write(): Promise<EngineHelpSourceSync>;
  diff(): Promise<string>;
};

type ExtractMetadata = {
  schema: 1;
  engine: string;
  entrypoint: string;
  sourcePaths: string[];
  hash: string;
  commit: string | null;
  updatedAt: string;
};

const CURRENT_EXTRACT_TTL_MS = 60_000;

function nowIso() {
  return new Date().toISOString();
}

function repositoryHead(repoPath: string) {
  if (!isExactGitRepositorySync(repoPath)) {
    return null;
  }
  return tryGitSync(repoPath, ["rev-parse", "HEAD"]);
}

function declarationCommits(input: {
  repoPath: string;
  storedCommit: string | null;
  head: string | null;
  paths: string[];
}) {
  if (!input.storedCommit || !input.head || input.storedCommit === input.head) {
    return input.storedCommit && input.storedCommit === input.head ? [] : null;
  }
  if (!isExactGitRepositorySync(input.repoPath)) {
    return null;
  }
  const output = tryGitSync(input.repoPath, [
    "log",
    "--oneline",
    "--no-decorate",
    "-n",
    "50",
    `${input.storedCommit}..${input.head}`,
    "--",
    ...input.paths,
  ]);
  return output === null ? null : output.split("\n").filter(Boolean);
}

function syncOf(input: {
  adapter: {
    id: string;
    displayName: string;
    sourceId: string;
    sourcePaths: string[];
  };
  kind: EngineHelpSourceSync["kind"];
  snapshotPath: string;
  metadataPath: string;
  stored: EngineHelpSourceSnapshot;
  current: EngineHelpSourceSnapshot;
  pendingCommits: string[] | null;
}): EngineHelpSourceSync {
  const comparable =
    input.stored.hash !== null &&
    input.current.hash !== null &&
    !input.stored.error &&
    !input.current.error;
  const inSync = comparable ? input.stored.hash === input.current.hash : null;

  return EngineHelpSourceSyncSchema.parse({
    engineId: input.adapter.id,
    displayName: input.adapter.displayName,
    kind: input.kind,
    sourceId: input.adapter.sourceId,
    sourcePaths: input.adapter.sourcePaths,
    snapshotPath: input.snapshotPath,
    metadataPath: input.metadataPath,
    stored: input.stored,
    current: input.current,
    inSync,
    signal: comparable
      ? "content-hash"
      : input.pendingCommits !== null
        ? "commit-range"
        : "none",
    pendingCommits: input.pendingCommits,
  });
}

function llamaAdapter(): EngineHelpSourceAdapter {
  const identity = {
    id: LLAMA_CPP_SOURCE_ID,
    displayName: "llama-server",
    sourceId: LLAMA_CPP_SOURCE_ID,
    sourcePaths: ["tools/server/README.md"],
  };

  const toSync = () => {
    const llama = getLlamaArgumentHelpSourceSync();
    const repoPath = sourceRepositoryPath(identity.sourceId);
    const stored = {
      path: llama.stored.path,
      exists: llama.stored.exists,
      hash: llama.stored.hash,
      commit: llama.stored.llamaCppCommit,
      updatedAt: llama.stored.updatedAt,
      error: llama.stored.error,
    };
    return syncOf({
      adapter: identity,
      kind: "help-block",
      snapshotPath: llama.snapshotPath,
      metadataPath: llama.metadataPath,
      stored,
      current: {
        path: llama.current.path,
        exists: llama.current.exists,
        hash: llama.current.hash,
        commit: llama.current.llamaCppCommit,
        updatedAt: llama.current.updatedAt,
        error: llama.current.error,
      },
      pendingCommits: declarationCommits({
        repoPath,
        storedCommit: stored.commit,
        head: llama.current.llamaCppCommit,
        paths: identity.sourcePaths,
      }),
    });
  };

  return {
    ...identity,
    async sync() {
      return toSync();
    },
    async write() {
      updateStoredGeneratedHelpSnapshot();
      return toSync();
    },
    async diff() {
      return generatedHelpDiff();
    },
  };
}

type ExtractAdapterInput = {
  id: string;
  displayName: string;
  sourceId: string;
  script: string;
  sourcePaths: string[];
  runner?: ExtractorRunner;
};

function extractSnapshotPaths(id: string) {
  const directory = resolve(
    config.rootDir,
    "content",
    "engine-args",
    id,
    "source",
  );
  return {
    snapshotPath: resolve(directory, "extract.json"),
    metadataPath: resolve(directory, "help-source.json"),
  };
}

function readExtractMetadata(path: string): ExtractMetadata | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ExtractMetadata>;
    if (parsed.schema !== 1 || typeof parsed.hash !== "string") {
      return null;
    }
    return {
      schema: 1,
      engine: typeof parsed.engine === "string" ? parsed.engine : "",
      entrypoint:
        typeof parsed.entrypoint === "string" ? parsed.entrypoint : "",
      sourcePaths: Array.isArray(parsed.sourcePaths) ? parsed.sourcePaths : [],
      hash: parsed.hash,
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    };
  } catch {
    return null;
  }
}

function storedExtractSnapshot(input: {
  snapshotPath: string;
  metadataPath: string;
}): {
  snapshot: EngineHelpSourceSnapshot;
  extract: EngineArgumentExtract | null;
} {
  const metadata = readExtractMetadata(input.metadataPath);
  if (!existsSync(input.snapshotPath)) {
    return {
      snapshot: {
        path: input.snapshotPath,
        exists: false,
        hash: metadata?.hash ?? null,
        commit: metadata?.commit ?? null,
        updatedAt: metadata?.updatedAt ?? null,
        error: "stored argument extract not found",
      },
      extract: null,
    };
  }

  const parsed = parseEngineArgumentExtract(
    readFileSync(input.snapshotPath, "utf8"),
  );
  if (!parsed.extract) {
    return {
      snapshot: {
        path: input.snapshotPath,
        exists: true,
        hash: metadata?.hash ?? null,
        commit: metadata?.commit ?? null,
        updatedAt: metadata?.updatedAt ?? null,
        error: parsed.error,
      },
      extract: null,
    };
  }

  const computed = engineArgumentSurfaceHash(parsed.extract);
  return {
    snapshot: {
      path: input.snapshotPath,
      exists: true,
      hash: metadata?.hash ?? computed,
      commit: metadata?.commit ?? null,
      updatedAt:
        metadata?.updatedAt ?? statSync(input.snapshotPath).mtime.toISOString(),
      error:
        metadata && metadata.hash !== computed
          ? `metadata hash ${metadata.hash} does not match snapshot hash ${computed}`
          : null,
    },
    extract: parsed.extract,
  };
}

function extractAdapter(input: ExtractAdapterInput): EngineHelpSourceAdapter {
  const identity = {
    id: input.id,
    displayName: input.displayName,
    sourceId: input.sourceId,
    sourcePaths: input.sourcePaths,
  };
  const { snapshotPath, metadataPath } = extractSnapshotPaths(input.id);
  const runner = input.runner ?? runArgumentExtractor;
  let cached: {
    key: string;
    expiresAt: number;
    run: Awaited<ReturnType<ExtractorRunner>>;
  } | null = null;

  async function currentExtract(repoPath: string, head: string | null) {
    const key = `${repoPath}|${head ?? "none"}`;
    const now = Date.now();
    if (cached && cached.key === key && cached.expiresAt > now) {
      return cached.run;
    }
    const run = await runner({ script: input.script, repoPath });
    cached = { key, expiresAt: now + CURRENT_EXTRACT_TTL_MS, run };
    return run;
  }

  async function readSides() {
    const repoPath = sourceRepositoryPath(identity.sourceId);
    const head = repositoryHead(repoPath);
    const stored = storedExtractSnapshot({ snapshotPath, metadataPath });
    const run = await currentExtract(repoPath, head);
    const parsed = run.payload ? parseEngineArgumentExtract(run.payload) : null;

    const current: EngineHelpSourceSnapshot = {
      path: repoPath,
      exists: existsSync(repoPath),
      hash: parsed?.extract ? engineArgumentSurfaceHash(parsed.extract) : null,
      commit: head,
      updatedAt: parsed?.extract ? nowIso() : null,
      error: run.error ?? parsed?.error ?? null,
    };

    return {
      repoPath,
      head,
      stored,
      current,
      currentExtract: parsed?.extract ?? null,
      payload: run.payload,
    };
  }

  async function toSync() {
    const sides = await readSides();
    return syncOf({
      adapter: identity,
      kind: "declaration-extract",
      snapshotPath,
      metadataPath,
      stored: sides.stored.snapshot,
      current: sides.current,
      pendingCommits: declarationCommits({
        repoPath: sides.repoPath,
        storedCommit: sides.stored.snapshot.commit,
        head: sides.head,
        paths: identity.sourcePaths,
      }),
    });
  }

  return {
    ...identity,
    sync: toSync,
    async write() {
      const sides = await readSides();
      if (!sides.currentExtract || !sides.payload) {
        throw new Error(
          sides.current.error ??
            `cannot extract ${identity.id} argument declarations`,
        );
      }
      const metadata: ExtractMetadata = {
        schema: 1,
        engine: sides.currentExtract.engine,
        entrypoint: sides.currentExtract.entrypoint,
        sourcePaths: sides.currentExtract.sourceFiles,
        hash: engineArgumentSurfaceHash(sides.currentExtract),
        commit: sides.head,
        updatedAt: nowIso(),
      };
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, normalizeHelpPayload(sides.payload), "utf8");
      writeFileSync(
        metadataPath,
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8",
      );
      cached = null;
      return toSync();
    },
    async diff() {
      const sides = await readSides();
      if (!sides.currentExtract) {
        throw new Error(
          sides.current.error ??
            `cannot extract ${identity.id} argument declarations`,
        );
      }
      return diffEngineArgumentExtracts(
        sides.stored.extract,
        sides.currentExtract,
      );
    },
  };
}

const adapters = new Map<string, EngineHelpSourceAdapter>(
  [
    llamaAdapter(),
    extractAdapter({
      id: "vllm",
      displayName: "vLLM",
      sourceId: "vllm",
      script: "vllm.py",
      sourcePaths: [
        "vllm/config",
        "vllm/engine/arg_utils.py",
        "vllm/entrypoints/openai/cli_args.py",
      ],
    }),
    extractAdapter({
      id: "sglang",
      displayName: "SGLang",
      sourceId: "sglang",
      script: "sglang.py",
      sourcePaths: ["python/sglang/srt/server_args.py"],
    }),
  ].map((adapter) => [adapter.id, adapter]),
);

export function listEngineHelpSourceAdapters() {
  return [...adapters.values()];
}

export function getEngineHelpSourceAdapter(engineId: string) {
  const adapter = adapters.get(engineId);
  if (!adapter) {
    throw new Error(`unknown engine help source: ${engineId}`);
  }
  return adapter;
}

export function createExtractHelpSourceAdapter(input: ExtractAdapterInput) {
  return extractAdapter(input);
}
