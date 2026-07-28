export const PUBLIC_PACKAGE_INDEX_URL = "https://pypi.org/simple/";

export type IndexFileEntry = {
  filename: string;
  requiresPython: string | null;
};

export type IndexDistributionResult =
  | { outcome: "ok"; files: IndexFileEntry[] }
  | { outcome: "auth-required" | "not-found"; detail: string }
  | { outcome: "unreachable"; detail: string };

export function normalizeDistributionName(name: string) {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

export function packageIndexProjectUrl(
  indexUrl: string,
  distribution: string,
): string {
  const base = indexUrl.endsWith("/") ? indexUrl : `${indexUrl}/`;
  return new URL(`${normalizeDistributionName(distribution)}/`, base).href;
}

export function looksLikeSimpleIndexUrl(indexUrl: string) {
  return /\/simple\/?$/.test(new URL(indexUrl).pathname);
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
};

function decodeEntities(value: string) {
  return value.replace(/&(#\d+|[a-z]+);/gi, (match, entity: string) => {
    const named = HTML_ENTITIES[entity.toLowerCase()];
    if (named) return named;
    if (entity.startsWith("#")) {
      const code = Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function attributeValue(attributes: string, name: string) {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(attributes);
  const raw = match?.[2] ?? match?.[3];
  return raw === undefined ? null : decodeEntities(raw);
}

function filenameFromHref(href: string) {
  const withoutFragment = href.split("#")[0] ?? href;
  const withoutQuery = withoutFragment.split("?")[0] ?? withoutFragment;
  const segments = withoutQuery.split("/").filter(Boolean);
  return segments.at(-1) ?? null;
}

export function parseSimpleIndexHtml(html: string): IndexFileEntry[] {
  const entries: IndexFileEntry[] = [];
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match = anchors.exec(html);
  while (match) {
    const attributes = match[1] ?? "";
    const text = decodeEntities((match[2] ?? "").replace(/<[^>]*>/g, "")).trim();
    const href = attributeValue(attributes, "href");
    const filename = text || (href ? filenameFromHref(href) : null);
    if (filename) {
      entries.push({
        filename,
        requiresPython: attributeValue(attributes, "data-requires-python"),
      });
    }
    match = anchors.exec(html);
  }
  return entries;
}

export function parseSimpleIndexJson(payload: unknown): IndexFileEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const entries: IndexFileEntry[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const filename = (file as { filename?: unknown }).filename;
    if (typeof filename !== "string" || !filename) continue;
    const requiresPython = (file as { "requires-python"?: unknown })[
      "requires-python"
    ];
    entries.push({
      filename,
      requiresPython:
        typeof requiresPython === "string" && requiresPython
          ? requiresPython
          : null,
    });
  }
  return entries;
}

export type DistributionFile = {
  version: string;
  pythonTag: string | null;
  platformTag: string | null;
};

const SDIST_SUFFIXES = [".tar.gz", ".tar.bz2", ".tar.xz", ".zip", ".tgz"];

export function parseDistributionFile(
  filename: string,
  distribution: string,
): DistributionFile | null {
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -4).split("-");
    if (parts.length < 5) return null;
    const version = parts[1];
    if (!version) return null;
    return {
      version,
      pythonTag: parts.at(-3) ?? null,
      platformTag: parts.at(-1) ?? null,
    };
  }
  const suffix = SDIST_SUFFIXES.find((candidate) =>
    filename.endsWith(candidate),
  );
  if (!suffix) return null;
  const stem = filename.slice(0, -suffix.length);
  const normalizedStem = normalizeDistributionName(stem);
  const prefix = `${normalizeDistributionName(distribution)}-`;
  if (!normalizedStem.startsWith(prefix)) return null;
  const version = stem.slice(prefix.length);
  return version ? { version, pythonTag: null, platformTag: null } : null;
}

const PRE_RELEASE_RANK: Record<string, number> = {
  a: 0,
  alpha: 0,
  b: 1,
  beta: 1,
  c: 2,
  rc: 2,
  pre: 2,
  preview: 2,
};

const VERSION_PATTERN =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:(?:[-_.]?(?:post|rev|r)[-_.]?(\d*))|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

type ComparableVersion = {
  epoch: number;
  release: number[];
  pre: [number, number];
  post: number;
  dev: number;
  local: string;
};

export function parseVersion(value: string): ComparableVersion | null {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const release = (match[2] ?? "").split(".").map(Number);
  if (release.some((segment) => !Number.isFinite(segment))) return null;
  const preLabel = match[3]?.toLowerCase();
  const postLabel = match[5] ?? match[6];
  const devLabel = match[7];
  const hasPre = preLabel !== undefined;
  const hasPost = postLabel !== undefined;
  const hasDev = devLabel !== undefined;
  const pre: [number, number] = hasPre
    ? [PRE_RELEASE_RANK[preLabel] ?? 2, Number(match[4] || "0")]
    : !hasPost && hasDev
      ? [Number.NEGATIVE_INFINITY, 0]
      : [Number.POSITIVE_INFINITY, 0];
  return {
    epoch: Number(match[1] ?? "0"),
    release,
    pre,
    post: hasPost ? Number(postLabel || "0") : Number.NEGATIVE_INFINITY,
    dev: hasDev ? Number(devLabel || "0") : Number.POSITIVE_INFINITY,
    local: match[8]?.toLowerCase() ?? "",
  };
}

function compareNumberLists(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  for (let position = 0; position < length; position += 1) {
    const leftSegment = left[position] ?? 0;
    const rightSegment = right[position] ?? 0;
    if (leftSegment === rightSegment) continue;
    return leftSegment < rightSegment ? -1 : 1;
  }
  return 0;
}

export function comparePackageVersions(left: string, right: string) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    if (parsedLeft) return -1;
    if (parsedRight) return 1;
    return left.localeCompare(right);
  }
  if (parsedLeft.epoch !== parsedRight.epoch) {
    return parsedLeft.epoch < parsedRight.epoch ? -1 : 1;
  }
  const releaseOrder = compareNumberLists(
    parsedLeft.release,
    parsedRight.release,
  );
  if (releaseOrder !== 0) return releaseOrder;
  const preOrder = compareNumberLists(parsedLeft.pre, parsedRight.pre);
  if (preOrder !== 0) return preOrder;
  if (parsedLeft.post !== parsedRight.post) {
    return parsedLeft.post < parsedRight.post ? -1 : 1;
  }
  if (parsedLeft.dev !== parsedRight.dev) {
    return parsedLeft.dev < parsedRight.dev ? -1 : 1;
  }
  return parsedLeft.local.localeCompare(parsedRight.local);
}

export function isPreReleaseVersion(value: string) {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  return Number.isFinite(parsed.pre[0]) || Number.isFinite(parsed.dev);
}
