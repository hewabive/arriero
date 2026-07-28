import type {
  EnvironmentEngine,
  EnvironmentIndexVersions,
  PackageIndexFile,
  PackageIndexVersion,
} from "@arriero/core";

import {
  comparePackageVersions,
  isPreReleaseVersion,
  looksLikeSimpleIndexUrl,
  packageIndexProjectUrl,
  parseDistributionFile,
  parseSimpleIndexHtml,
  parseSimpleIndexJson,
  PUBLIC_PACKAGE_INDEX_URL,
  satisfiesRequiresPython,
  type IndexDistributionResult,
  type IndexFileEntry,
} from "./package-index.js";
import { environmentProvisioner } from "./provisioners.js";

const SIMPLE_ACCEPT =
  "application/vnd.pypi.simple.v1+json;q=1, application/vnd.pypi.simple.v1+html;q=0.2, text/html;q=0.1";

export type IndexDistributionFetcher = (
  url: string,
) => Promise<IndexDistributionResult>;

export async function fetchIndexDistribution(
  url: string,
  timeoutMs = 8_000,
): Promise<IndexDistributionResult> {
  try {
    const response = await fetch(url, {
      headers: { accept: SIMPLE_ACCEPT },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        outcome: "auth-required",
        detail: `index returned ${response.status}`,
      };
    }
    if (response.status === 404 || response.status === 410) {
      return {
        outcome: "not-found",
        detail: `index returned ${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        outcome: "unreachable",
        detail:
          `index returned ${response.status} ${response.statusText}`.trim(),
      };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const files = contentType.includes("json")
      ? parseSimpleIndexJson(JSON.parse(body))
      : parseSimpleIndexHtml(body);
    return { outcome: "ok", files };
  } catch (error) {
    return { outcome: "unreachable", detail: describeFetchFailure(error) };
  }
}

function describeFetchFailure(error: unknown) {
  const message = (error as Error).message || "request failed";
  const cause = (error as { cause?: unknown }).cause;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : null;
  return causeMessage && !message.includes(causeMessage)
    ? `${message}: ${causeMessage}`
    : message;
}

function collectVersions(
  distribution: string,
  files: IndexFileEntry[],
): Map<string, { requiresPython: string | null; files: PackageIndexFile[] }> {
  const versions = new Map<
    string,
    { requiresPython: string | null; files: PackageIndexFile[] }
  >();
  for (const file of files) {
    const parsed = parseDistributionFile(file.filename, distribution);
    if (!parsed) continue;
    const existing = versions.get(parsed.version) ?? {
      requiresPython: null,
      files: [],
    };
    existing.files.push({
      filename: file.filename,
      pythonTag: parsed.pythonTag,
      platformTag: parsed.platformTag,
    });
    if (!existing.requiresPython && file.requiresPython) {
      existing.requiresPython = file.requiresPython;
    }
    versions.set(parsed.version, existing);
  }
  return versions;
}

function indexHint(indexUrl: string) {
  try {
    return looksLikeSimpleIndexUrl(indexUrl)
      ? null
      : "the URL does not end with /simple, which most registries require";
  } catch {
    return null;
  }
}

export async function resolveEnvironmentIndexVersions(input: {
  engine: EnvironmentEngine;
  indexUrl: string | null;
  pythonVersion?: string | null;
  fetcher?: IndexDistributionFetcher;
}): Promise<EnvironmentIndexVersions> {
  const indexUrl = input.indexUrl?.trim() || PUBLIC_PACKAGE_INDEX_URL;
  const distributions = [...environmentProvisioner(input.engine).distributions];
  const fetcher =
    input.fetcher ?? ((url: string) => fetchIndexDistribution(url));
  const base = {
    engine: input.engine,
    indexUrl,
    distributions,
    versions: [] as PackageIndexVersion[],
  };

  let projectUrls: string[];
  try {
    projectUrls = distributions.map((distribution) =>
      packageIndexProjectUrl(indexUrl, distribution),
    );
  } catch (error) {
    return {
      ...base,
      status: "unreachable",
      message: `index URL is not usable: ${(error as Error).message}`,
    };
  }

  const results = await Promise.all(projectUrls.map(fetcher));

  const unreachable = results.find(
    (result) => result.outcome === "unreachable",
  );
  if (unreachable && unreachable.outcome === "unreachable") {
    return { ...base, status: "unreachable", message: unreachable.detail };
  }
  if (results.some((result) => result.outcome === "auth-required")) {
    return {
      ...base,
      status: "auth-required",
      message: "the index requires authentication for read access",
    };
  }

  const missing = distributions.filter(
    (_, position) => results[position]?.outcome === "not-found",
  );
  if (missing.length) {
    const hint = indexHint(indexUrl);
    return {
      ...base,
      status: missing.length === distributions.length ? "not-found" : "empty",
      message: `${missing.join(" and ")} not published on this index${hint ? `; ${hint}` : ""}`,
    };
  }

  const perDistribution = distributions.map((distribution, position) => {
    const result = results[position];
    return collectVersions(
      distribution,
      result?.outcome === "ok" ? result.files : [],
    );
  });

  const allVersions = new Set<string>();
  for (const versions of perDistribution) {
    for (const version of versions.keys()) allVersions.add(version);
  }

  const versions: PackageIndexVersion[] = [...allVersions]
    .sort((left, right) => comparePackageVersions(right, left))
    .map((version) => {
      const files: PackageIndexFile[] = [];
      let requiresPython: string | null = null;
      const missingDistributions: string[] = [];
      distributions.forEach((distribution, position) => {
        const entry = perDistribution[position]?.get(version);
        if (!entry) {
          missingDistributions.push(distribution);
          return;
        }
        files.push(...entry.files);
        if (!requiresPython) requiresPython = entry.requiresPython;
      });
      return {
        version,
        requiresPython,
        pythonCompatible: input.pythonVersion
          ? satisfiesRequiresPython(requiresPython, input.pythonVersion)
          : null,
        preRelease: isPreReleaseVersion(version),
        files,
        missingDistributions,
      };
    });

  if (!versions.length) {
    const hint = indexHint(indexUrl);
    return {
      ...base,
      status: "empty",
      message: `no ${distributions.join(" / ")} releases found on this index${hint ? `; ${hint}` : ""}`,
    };
  }

  return { ...base, status: "ok", message: null, versions };
}
