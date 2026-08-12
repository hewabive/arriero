import {
  LLAMA_CPP_SOURCE_ID,
  type EngineArgumentExtract,
  type EngineHelpSourceSnapshot,
  type EngineHelpSourceSync,
  type LlamaArgumentHelpSourceSnapshot,
} from "@arriero/core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { repositoryHeadCommit, tryGit } from "../git/process.js";
import { getSourceRepositoryDefinition } from "../sources/registry.js";
import { sourceRepositoryPath } from "../sources/repository.js";
import {
  engineArgumentContentPaths,
  readEngineExtractMetadata,
  readStoredEngineExtract,
} from "./engine-content.js";
import {
  generatedHelpDiff,
  getLlamaArgumentHelpSourceSync,
  updateStoredGeneratedHelpSnapshot,
} from "./docs-source.js";
import {
  diffEngineArgumentExtracts,
  engineArgumentSurfaceHash,
  normalizeHelpPayload,
  nowIso,
  parseEngineArgumentExtract,
  type ParsedExtract,
} from "./help-source.js";
import {
  runArgumentExtractor,
  type ExtractorRunner,
} from "./help-source-extract.js";

export type EngineHelpSourceAdapter = {
  id: string;
  displayName: string;
  kind: EngineHelpSourceSync["kind"];
  sourceId: string;
  sourcePaths: string[];
  coveredByDriftReport: boolean;
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

type StoredExtractMetadata = Pick<
  ExtractMetadata,
  "hash" | "commit" | "updatedAt"
>;

const CURRENT_EXTRACT_TTL_MS = 600_000;

async function declarationCommits(input: {
  repoPath: string;
  storedCommit: string | null;
  head: string | null;
  paths: string[];
}): Promise<string[] | null> {
  if (!input.storedCommit || !input.head) {
    return null;
  }
  if (input.storedCommit === input.head) {
    return [];
  }
  const output = await tryGit(input.repoPath, [
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
    kind: EngineHelpSourceSync["kind"];
    sourceId: string;
    sourcePaths: string[];
  };
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

  return {
    engineId: input.adapter.id,
    displayName: input.adapter.displayName,
    kind: input.adapter.kind,
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
  };
}

function engineSnapshot({
  llamaCppCommit,
  ...rest
}: LlamaArgumentHelpSourceSnapshot): EngineHelpSourceSnapshot {
  return { ...rest, commit: llamaCppCommit };
}

function llamaAdapter(): EngineHelpSourceAdapter {
  const identity = {
    id: LLAMA_CPP_SOURCE_ID,
    displayName: "llama-server",
    kind: "help-block" as const,
    sourceId: LLAMA_CPP_SOURCE_ID,
    sourcePaths: ["tools/server/README.md"],
  };

  const toSync = async () => {
    const llama = getLlamaArgumentHelpSourceSync();
    const stored = engineSnapshot(llama.stored);
    return syncOf({
      adapter: identity,
      snapshotPath: llama.snapshotPath,
      metadataPath: llama.metadataPath,
      stored,
      current: engineSnapshot(llama.current),
      pendingCommits: await declarationCommits({
        repoPath: sourceRepositoryPath(identity.sourceId),
        storedCommit: stored.commit,
        head: llama.current.llamaCppCommit,
        paths: identity.sourcePaths,
      }),
    });
  };

  return {
    ...identity,
    coveredByDriftReport: true,
    sync: toSync,
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

function readExtractMetadata(engineId: string): StoredExtractMetadata | null {
  const parsed = readEngineExtractMetadata(engineId);
  if (!parsed || parsed.schema !== 1 || typeof parsed.hash !== "string") {
    return null;
  }
  return {
    hash: parsed.hash,
    commit: typeof parsed.commit === "string" ? parsed.commit : null,
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
  };
}

function storedExtractSnapshot(engineId: string): {
  snapshot: EngineHelpSourceSnapshot;
  extract: EngineArgumentExtract | null;
} {
  const metadata = readExtractMetadata(engineId);
  const stored = readStoredEngineExtract(engineId);
  if (!stored.extract) {
    return {
      snapshot: {
        path: stored.path,
        exists: stored.exists,
        hash: metadata?.hash ?? null,
        commit: metadata?.commit ?? null,
        updatedAt: metadata?.updatedAt ?? null,
        error: stored.error,
      },
      extract: null,
    };
  }

  const computed = engineArgumentSurfaceHash(stored.extract);
  return {
    snapshot: {
      path: stored.path,
      exists: true,
      hash: metadata?.hash ?? computed,
      commit: metadata?.commit ?? null,
      updatedAt: metadata?.updatedAt ?? stored.updatedAt,
      error:
        metadata && metadata.hash !== computed
          ? `metadata hash ${metadata.hash} does not match snapshot hash ${computed}`
          : null,
    },
    extract: stored.extract,
  };
}

export function createExtractHelpSourceAdapter(
  input: ExtractAdapterInput,
): EngineHelpSourceAdapter {
  const identity = {
    id: input.id,
    displayName: input.displayName,
    kind: "declaration-extract" as const,
    sourceId: input.sourceId,
    sourcePaths: input.sourcePaths,
  };
  const { snapshotPath, metadataPath } = engineArgumentContentPaths(input.id);
  const runner = input.runner ?? runArgumentExtractor;
  type CurrentExtract = {
    run: Awaited<ReturnType<ExtractorRunner>>;
    parsed: ParsedExtract | null;
    hash: string | null;
  };
  let cached: {
    key: string;
    expiresAt: number;
    value: CurrentExtract;
  } | null = null;

  async function currentExtract(
    repoPath: string,
    head: string | null,
  ): Promise<CurrentExtract> {
    const key = `${repoPath}|${head ?? "none"}`;
    const now = Date.now();
    if (cached && cached.key === key && cached.expiresAt > now) {
      return cached.value;
    }
    const run = await runner({ script: input.script, repoPath });
    const parsed = run.payload ? parseEngineArgumentExtract(run.payload) : null;
    const value = {
      run,
      parsed,
      hash: parsed?.extract ? engineArgumentSurfaceHash(parsed.extract) : null,
    };
    cached = { key, expiresAt: now + CURRENT_EXTRACT_TTL_MS, value };
    return value;
  }

  async function readSides() {
    const repoPath = sourceRepositoryPath(identity.sourceId);
    const head = await repositoryHeadCommit(repoPath);
    const stored = storedExtractSnapshot(input.id);
    const { run, parsed, hash } = await currentExtract(repoPath, head);

    const current: EngineHelpSourceSnapshot = {
      path: repoPath,
      exists: existsSync(repoPath),
      hash,
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
      snapshotPath,
      metadataPath,
      stored: sides.stored.snapshot,
      current: sides.current,
      pendingCommits: await declarationCommits({
        repoPath: sides.repoPath,
        storedCommit: sides.stored.snapshot.commit,
        head: sides.head,
        paths: identity.sourcePaths,
      }),
    });
  }

  return {
    ...identity,
    coveredByDriftReport: false,
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
    createExtractHelpSourceAdapter({
      id: "vllm",
      displayName: getSourceRepositoryDefinition("vllm").displayName,
      sourceId: "vllm",
      script: "vllm.py",
      sourcePaths: [
        "vllm/config",
        "vllm/engine/arg_utils.py",
        "vllm/entrypoints/openai/cli_args.py",
      ],
    }),
    createExtractHelpSourceAdapter({
      id: "sglang",
      displayName: getSourceRepositoryDefinition("sglang").displayName,
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
