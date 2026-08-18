import type {
  LlamaArgumentDocIndex,
  LlamaArgumentEngineeringDoc,
  ArgumentOption,
} from "@arriero/core";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";

export const argumentDocsDirectory = resolve(
  config.rootDir,
  "content",
  "llama-args",
  "llama-server",
);

type ParsedDocFile = {
  frontmatter: Record<string, unknown>;
  markdown: string;
};

export function argumentDocFiles(directory: string) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => !name.startsWith("_") && name !== "README.md")
    .map((name) => resolve(directory, name))
    .sort((left, right) => left.localeCompare(right));
}

export function argumentDocSlug(primaryName: string) {
  return (
    primaryName
      .replace(/^-+/, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "argument"
  );
}

function argumentDocPath(primaryName: string, directory: string) {
  return resolve(directory, `${argumentDocSlug(primaryName)}.md`);
}

function readFilePrefix(path: string, maxBytes = 128 * 1024) {
  const stat = statSync(path);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function scalarValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => String(scalarValue(item)));
  }
  return trimmed;
}

export function parseArgumentDocFile(raw: string): ParsedDocFile {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return {
      frontmatter: {},
      markdown: raw.trim(),
    };
  }

  const delimiter = raw.startsWith("---\r\n") ? "\r\n---" : "\n---";
  const end = raw.indexOf(delimiter, 4);
  if (end === -1) {
    return {
      frontmatter: {},
      markdown: raw.trim(),
    };
  }

  const frontmatterText = raw.slice(4, end).trim();
  const markdown = raw
    .slice(end + delimiter.length)
    .replace(/^\r?\n/, "")
    .trim();
  const frontmatter: Record<string, unknown> = {};
  let activeArrayKey: string | null = null;

  for (const line of frontmatterText.split(/\r?\n/)) {
    const arrayItem = line.match(/^\s*-\s+(.+)$/);
    if (activeArrayKey && arrayItem) {
      const list = frontmatter[activeArrayKey];
      if (Array.isArray(list)) {
        list.push(String(scalarValue(arrayItem[1]!)));
      }
      continue;
    }

    activeArrayKey = null;
    const property = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!property) {
      continue;
    }

    const key = property[1]!;
    const value = property[2]!;
    if (!value.trim()) {
      frontmatter[key] = [];
      activeArrayKey = key;
      continue;
    }
    frontmatter[key] = scalarValue(value);
  }

  return {
    frontmatter,
    markdown,
  };
}

function stringFrontmatter(
  frontmatter: Record<string, unknown>,
  key: string,
): string | null {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstMarkdownParagraph(markdown: string) {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  return paragraph?.replace(/\s+/g, " ").slice(0, 240) ?? null;
}

const docIndexCache = new Map<
  string,
  { mtimeMs: number; size: number; value: LlamaArgumentDocIndex }
>();

function readArgumentDocIndex(
  path: string,
  stat: Stats,
): LlamaArgumentDocIndex {
  const parsed = parseArgumentDocFile(readFilePrefix(path));
  return {
    exists: true,
    path,
    summary:
      stringFrontmatter(parsed.frontmatter, "summary") ??
      firstMarkdownParagraph(parsed.markdown),
    updatedAt: stat.mtime.toISOString(),
  };
}

function getArgumentDocIndex(
  option: ArgumentOption,
  directory: string,
): LlamaArgumentDocIndex {
  const path = argumentDocPath(option.primaryName, directory);
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    docIndexCache.delete(path);
    return {
      exists: false,
      path,
      summary: null,
      updatedAt: null,
    };
  }
  const cached = docIndexCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value;
  }
  const value = readArgumentDocIndex(path, stat);
  docIndexCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

export function withArgumentDocIndex(
  options: ArgumentOption[],
  directory = argumentDocsDirectory,
) {
  return options.map((option) => ({
    ...option,
    doc: getArgumentDocIndex(option, directory),
  }));
}

export function readArgumentEngineeringDoc(input: {
  primaryName: string;
  option?: ArgumentOption | null;
  directory?: string;
}): LlamaArgumentEngineeringDoc {
  const path = argumentDocPath(
    input.primaryName,
    input.directory ?? argumentDocsDirectory,
  );
  if (!existsSync(path)) {
    return {
      primaryName: input.primaryName,
      path,
      exists: false,
      title: null,
      summary: null,
      updatedAt: null,
      frontmatter: {},
      markdown: "",
    };
  }

  const parsed = parseArgumentDocFile(readFileSync(path, "utf8"));
  const title =
    stringFrontmatter(parsed.frontmatter, "title") ??
    parsed.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    input.option?.primaryName ??
    input.primaryName;

  return {
    primaryName: input.primaryName,
    path,
    exists: true,
    title,
    summary:
      stringFrontmatter(parsed.frontmatter, "summary") ??
      firstMarkdownParagraph(parsed.markdown),
    updatedAt: statSync(path).mtime.toISOString(),
    frontmatter: parsed.frontmatter,
    markdown: parsed.markdown,
  };
}
