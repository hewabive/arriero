import {
  parseHfRepoInput,
  parseSplitInfo,
  type HfRepoBrowse,
  type ModelImportCandidate,
  type ModelImportRequest,
  type ModelImportState,
} from "@arriero/core";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { getCachedModelEntry } from "../models/cache-repository.js";
import { getCachedSafetensorsEntry } from "../models/safetensors-cache-repository.js";
import { browseHfRepo } from "./browse.js";
import {
  HfHubError,
  searchHfModels,
  type HfClientOptions,
  type HfSearchModel,
} from "./client.js";
import {
  discoverRelatedFiles,
  type ImportRelatedFile,
} from "./import-neighbors.js";
import {
  collectImportFiles,
  planModelImport,
  type ImportSourceFile,
  type ModelImportPlan,
} from "./model-import-plan.js";
import { HfDownloadRequestError } from "./paths.js";
import { getHfToken } from "./token.js";

export type DiscoveredImport = {
  candidate: ModelImportCandidate;
  plan: ModelImportPlan;
  related: ImportRelatedFile[];
};
const repoCache = new Map<string, { at: number; repo: HfRepoBrowse }>();

function importSearchName(name: string): string {
  const split = parseSplitInfo(name);
  return (split?.prefix ?? name.replace(/\.(gguf|safetensors)$/i, ""))
    .replace(
      /[-_.](?:UD-)?(?:(?:I?Q|TQ|MXFP)\d(?:_[A-Z0-9]+)*|BF16|F16|F32)$/i,
      "",
    )
    .replace(/^(?:mmproj|mtp)-/i, "");
}

async function withQuotaRetry<T>(
  operation: () => Promise<T>,
  state: ModelImportState,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof HfHubError) ||
        error.kind !== "rate-limited" ||
        attempt >= 2
      )
        throw error;
      const delay = Math.min(
        300000,
        Math.max(1000, error.retryAfterMs ?? 30000),
      );
      state.currentFile = `Hugging Face request limit; retrying in ${Math.ceil(delay / 1000)} seconds`;
      await setTimeout(delay, undefined, { signal });
    }
  }
}

async function browseImportRepo(
  repoId: string,
  revision: string,
  state: ModelImportState,
  options: HfClientOptions,
  signal: AbortSignal,
): Promise<HfRepoBrowse> {
  const key = `${options.token ?? getHfToken() ?? ""}\0${repoId}\0${revision}`;
  const cached = options.fetchImpl ? null : repoCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.repo;
  const repo = await withQuotaRetry(
    () => browseHfRepo({ repoId, revision }, options),
    state,
    signal,
  );
  if (!options.fetchImpl) {
    if (repoCache.size >= 60) repoCache.delete(repoCache.keys().next().value!);
    repoCache.set(key, { at: Date.now(), repo });
  }
  return repo;
}

function searchHints(input: ModelImportRequest) {
  const path = resolve(input.sourcePath);
  const metadata = getCachedModelEntry(path)?.model?.metadata;
  const safetensors =
    input.scope === "directory"
      ? getCachedSafetensorsEntry(path)?.model?.metadata
      : null;
  const base =
    metadata?.baseModels.map((model) => model.repoUrl).find(Boolean) ??
    safetensors?.baseModel;
  const baseId = base ? (parseHfRepoInput(base)?.repoId ?? null) : null;
  const repoUrl = metadata?.repoUrl;
  const directRepo = repoUrl
    ? (parseHfRepoInput(repoUrl)?.repoId ?? null)
    : null;
  const author =
    repoUrl?.match(/^https:\/\/huggingface\.co\/([\w.-]+)\/?$/)?.[1] ??
    metadata?.quantizedBy?.match(/^[\w.-]+$/)?.[0];
  const filenameName = importSearchName(basename(path));
  const generic = /^(?:mmproj|model|weights|pytorch_model|f16|q8_0)$/i.test(
    filenameName,
  );
  const term =
    input.repo.trim() ||
    (generic
      ? (baseId?.split("/")[1] ?? metadata?.name ?? filenameName)
      : filenameName);
  return { term, baseId, directRepo, author };
}

async function findRepositories(
  input: ModelImportRequest,
  sources: ImportSourceFile[],
  state: ModelImportState,
  options: HfClientOptions,
  signal: AbortSignal,
): Promise<Array<{ repoId: string; revision: string }>> {
  const explicit = parseHfRepoInput(input.repo);
  if (explicit)
    return [
      {
        repoId: explicit.repoId,
        revision: explicit.revision ?? input.revision,
      },
    ];
  const hints = searchHints(input);
  const gguf = sources.some((file) =>
    file.path.toLowerCase().endsWith(".gguf"),
  );
  const filters = gguf ? ["gguf"] : [];
  const queries: Array<{ search: string; author?: string; filters: string[] }> =
    [];
  if (hints.author || hints.baseId)
    queries.push({
      search: hints.baseId ? "" : hints.term,
      ...(hints.author ? { author: hints.author } : {}),
      filters: [
        ...filters,
        ...(hints.baseId
          ? [`base_model:${gguf ? "quantized:" : ""}${hints.baseId}`]
          : []),
      ],
    });
  queries.push({ search: hints.term, filters });
  if (hints.baseId)
    queries.push({
      search: "",
      filters: [...filters, `base_model:${hints.baseId}`],
    });
  if (gguf) queries.push({ search: hints.term, filters: [] });
  const models = new Map<string, HfSearchModel>();
  for (const query of queries) {
    state.currentFile = query.search || hints.baseId;
    const result = await withQuotaRetry(
      () => searchHfModels(query, options),
      state,
      signal,
    );
    state.searchTruncated ||= result.truncated;
    for (const model of result.models) models.set(model.id, model);
  }
  const names = new Set(
    sources.map((file) => basename(file.path).toLowerCase()),
  );
  const ranked = [...models.values()].filter((model) =>
    model.siblings.some((file) =>
      gguf
        ? file.rfilename.toLowerCase().endsWith(".gguf")
        : file.rfilename.toLowerCase().endsWith(".safetensors"),
    ),
  );
  const rank = (model: HfSearchModel) =>
    (model.siblings.some((file) =>
      names.has(basename(file.rfilename).toLowerCase()),
    )
      ? 0
      : 2) + (hints.author && !model.id.startsWith(`${hints.author}/`) ? 1 : 0);
  ranked.sort((a, b) => rank(a) - rank(b));
  state.searchTruncated ||= ranked.length > 30;
  const result = ranked.slice(0, 30).map((model) => ({
    repoId: model.id,
    revision: input.revision === "main" ? model.sha : input.revision,
  }));
  if (
    hints.directRepo &&
    !result.some((entry) => entry.repoId === hints.directRepo)
  )
    result.unshift({ repoId: hints.directRepo, revision: input.revision });
  return result;
}

export async function discoverModelImports(
  input: ModelImportRequest,
  state: ModelImportState,
  clientOptions: HfClientOptions | undefined,
  signal: AbortSignal,
): Promise<DiscoveredImport[]> {
  const options = { ...clientOptions, signal };
  const sources = await collectImportFiles(
    resolve(input.sourcePath),
    input.scope === "directory",
  );
  const repositories = await findRepositories(
    input,
    sources,
    state,
    options,
    signal,
  );
  const explicit = parseHfRepoInput(input.repo) !== null;
  const results: DiscoveredImport[] = [];
  state.total = repositories.length;
  for (const repository of repositories) {
    signal.throwIfAborted();
    state.currentFile = repository.repoId;
    state.searchedRepositories++;
    try {
      const remote = await browseImportRepo(
        repository.repoId,
        repository.revision,
        state,
        options,
        signal,
      );
      const candidateState: ModelImportState = {
        ...state,
        files: [],
        warnings: [],
        candidates: [],
        completed: 0,
      };
      const plan = await planModelImport(
        { ...input, repo: repository.repoId, revision: remote.commitSha },
        candidateState,
        options,
        signal,
        remote,
      );
      let related: ImportRelatedFile[] = [];
      try {
        related = await discoverRelatedFiles(plan, remote, state, signal);
      } catch (error) {
        signal.throwIfAborted();
        state.warnings.push(
          `Could not finish checking neighbors in ${dirname(plan.source)}: ${(error as Error).message}`,
        );
      }
      const candidate = {
        id: randomUUID(),
        repoId: repository.repoId,
        revision: remote.commitSha,
        files: candidateState.files,
        relatedFiles: related.map((entry) => entry.file),
      };
      results.push({ candidate, plan, related });
      state.candidates = results.map((result) => result.candidate);
    } catch (error) {
      signal.throwIfAborted();
      if (explicit) throw error;
      if (!(error instanceof HfDownloadRequestError))
        state.warnings.push(
          `Could not verify ${repository.repoId}: ${(error as Error).message}`,
        );
    }
    state.completed++;
  }
  if (!results.length)
    throw new HfDownloadRequestError(
      "No matching content found among the checked repositories. Refine the model name or enter a repository URL and revision.",
    );
  return results;
}
