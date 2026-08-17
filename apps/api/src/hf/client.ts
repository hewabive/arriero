import {
  encodeHfPathSegments,
  type HfLfsInfo,
  type HfTreeFile,
} from "@arriero/core";
import { z } from "zod";

import { getHfToken } from "./token.js";

const HF_BASE_URL = "https://huggingface.co";
const MAX_TREE_PAGES = 10;
const PATHS_INFO_CHUNK = 1_000;
const MAX_ERROR_DETAIL_LENGTH = 300;

export type HfErrorKind =
  | "unauthorized"
  | "gated"
  | "not-found"
  | "rate-limited"
  | "upstream"
  | "network";

export class HfHubError extends Error {
  readonly kind: HfErrorKind;
  readonly status: number | null;

  constructor(kind: HfErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "HfHubError";
    this.kind = kind;
    this.status = status;
  }
}

export type HfClientOptions = {
  fetchImpl?: typeof fetch | undefined;
  token?: string | null | undefined;
};

export type HfRepoInfo = {
  sha: string;
  gated: boolean;
  private: boolean;
};

const HfRepoInfoResponseSchema = z.object({
  sha: z.string().min(1),
  gated: z.union([z.boolean(), z.string()]).optional(),
  private: z.boolean().optional(),
});

const HfTreeEntrySchema = z.object({
  type: z.string(),
  path: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  oid: z.string().min(1),
  lfs: z
    .object({
      oid: z.string().min(1),
      size: z.number().int().nonnegative(),
    })
    .optional(),
  lastCommit: z
    .object({
      id: z.string().min(1),
      date: z.string(),
    })
    .optional(),
});

export type HfPathInfo = {
  size: number;
  oid: string;
  lfs: HfLfsInfo | null;
  lastCommitId: string | null;
  lastCommitDate: string | null;
};

export function hfResolveUrl(
  repoId: string,
  revision: string,
  path: string,
): string {
  return `${HF_BASE_URL}/${encodeHfPathSegments(repoId)}/resolve/${encodeURIComponent(revision)}/${encodeHfPathSegments(path)}`;
}

function resolveToken(options?: HfClientOptions): string | null {
  return options && options.token !== undefined ? options.token : getHfToken();
}

export function hfRequestHeaders(
  options?: HfClientOptions,
): Record<string, string> {
  const token = resolveToken(options);
  return token ? { authorization: `Bearer ${token}` } : {};
}

const HF_ERROR_MESSAGES: Record<Exclude<HfErrorKind, "network">, string> = {
  unauthorized:
    "repository not found, or it is private/gated and the HuggingFace token is missing or invalid",
  gated:
    "access denied: the repository is gated or private; configure a HuggingFace token with access",
  "not-found": "repository, revision or path not found on HuggingFace",
  "rate-limited": "HuggingFace API rate limit reached, retry later",
  upstream: "HuggingFace returned an unexpected error",
};

export async function hfErrorFromResponse(
  response: Response,
): Promise<HfHubError> {
  const kind: Exclude<HfErrorKind, "network"> =
    response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "gated"
        : response.status === 404
          ? "not-found"
          : response.status === 429
            ? "rate-limited"
            : "upstream";
  let detail = "";
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: unknown };
    detail =
      typeof parsed.error === "string"
        ? parsed.error
        : body.slice(0, MAX_ERROR_DETAIL_LENGTH);
  } catch {
    detail = "";
  }
  const base = `${HF_ERROR_MESSAGES[kind]} (HTTP ${response.status})`;
  const message = detail
    ? `${base}: ${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}`
    : base;
  return new HfHubError(kind, response.status, message);
}

async function hfFetch(
  url: string,
  init: RequestInit,
  options?: HfClientOptions,
): Promise<Response> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new HfHubError(
      "network",
      null,
      `HuggingFace request failed: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw await hfErrorFromResponse(response);
  }
  return response;
}

async function hfApiJson(
  url: string,
  init: RequestInit,
  options?: HfClientOptions,
): Promise<unknown> {
  const response = await hfFetch(
    url,
    { ...init, headers: { ...hfRequestHeaders(options), ...init.headers } },
    options,
  );
  try {
    return await response.json();
  } catch (error) {
    throw new HfHubError(
      "upstream",
      response.status,
      `HuggingFace returned invalid JSON: ${(error as Error).message}`,
    );
  }
}

export async function fetchHfRepoInfo(
  repoId: string,
  revision: string,
  options?: HfClientOptions,
): Promise<HfRepoInfo> {
  const url = `${HF_BASE_URL}/api/models/${encodeHfPathSegments(repoId)}/revision/${encodeURIComponent(revision)}`;
  const raw = await hfApiJson(url, {}, options);
  const parsed = HfRepoInfoResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HfHubError(
      "upstream",
      null,
      `HuggingFace repo info has an unexpected shape for ${repoId}@${revision}`,
    );
  }
  return {
    sha: parsed.data.sha,
    gated: Boolean(parsed.data.gated),
    private: parsed.data.private ?? false,
  };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(linkHeader);
  return match?.[1] ?? null;
}

function treeFileFromEntry(
  entry: z.infer<typeof HfTreeEntrySchema>,
): HfTreeFile {
  return {
    path: entry.path,
    size: entry.lfs?.size ?? entry.size ?? 0,
    oid: entry.oid,
    lfs: entry.lfs ? { oid: entry.lfs.oid, size: entry.lfs.size } : null,
  };
}

export async function fetchHfTree(
  repoId: string,
  revision: string,
  options?: HfClientOptions,
): Promise<{ files: HfTreeFile[]; truncated: boolean }> {
  const files: HfTreeFile[] = [];
  let url: string | null =
    `${HF_BASE_URL}/api/models/${encodeHfPathSegments(repoId)}/tree/${encodeURIComponent(revision)}?recursive=true&limit=1000`;
  let pages = 0;
  let truncated = false;
  while (url) {
    if (pages >= MAX_TREE_PAGES) {
      truncated = true;
      break;
    }
    pages += 1;
    const response = await hfFetch(
      url,
      { headers: hfRequestHeaders(options) },
      options,
    );
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new HfHubError(
        "upstream",
        response.status,
        `HuggingFace tree response is not JSON: ${(error as Error).message}`,
      );
    }
    const parsed = z.array(HfTreeEntrySchema).safeParse(raw);
    if (!parsed.success) {
      throw new HfHubError(
        "upstream",
        response.status,
        `HuggingFace tree response has an unexpected shape for ${repoId}@${revision}`,
      );
    }
    for (const entry of parsed.data) {
      if (entry.type === "file") {
        files.push(treeFileFromEntry(entry));
      }
    }
    url = parseNextLink(response.headers.get("link"));
  }
  return { files, truncated };
}

export async function fetchHfPathsInfo(
  repoId: string,
  revision: string,
  paths: readonly string[],
  expand: boolean,
  options?: HfClientOptions,
): Promise<Map<string, HfPathInfo>> {
  const result = new Map<string, HfPathInfo>();
  for (let start = 0; start < paths.length; start += PATHS_INFO_CHUNK) {
    const chunk = paths.slice(start, start + PATHS_INFO_CHUNK);
    const raw = await hfApiJson(
      `${HF_BASE_URL}/api/models/${encodeHfPathSegments(repoId)}/paths-info/${encodeURIComponent(revision)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: chunk, expand }),
      },
      options,
    );
    const parsed = z.array(HfTreeEntrySchema).safeParse(raw);
    if (!parsed.success) {
      throw new HfHubError(
        "upstream",
        null,
        `HuggingFace paths-info response has an unexpected shape for ${repoId}@${revision}`,
      );
    }
    for (const entry of parsed.data) {
      if (entry.type !== "file") {
        continue;
      }
      result.set(entry.path, {
        size: entry.lfs?.size ?? entry.size ?? 0,
        oid: entry.oid,
        lfs: entry.lfs ? { oid: entry.lfs.oid, size: entry.lfs.size } : null,
        lastCommitId: entry.lastCommit?.id ?? null,
        lastCommitDate: entry.lastCommit?.date ?? null,
      });
    }
  }
  return result;
}
