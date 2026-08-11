import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flagValue, hasFlag } from "./cli-flags.js";
import { argumentDocsDirectory, parseArgumentDocFile } from "./docs.js";
import { LlamaArgumentEstimationSchema } from "./estimation.js";

const stalePatterns = [
  /Этот файл создан автоматически/i,
  /Для точного описания механики нужно проверить/i,
  /Что проверить агенту перед завершением/i,
  /Автоматически связанные аргументы/i,
  /\bTODO\b/i,
];

const requiredFrontmatter = [
  "schema",
  "primaryName",
  "title",
  "summary",
  "category",
  "valueType",
  "estimation",
  "aliases",
  "related",
];

const obsoleteFrontmatter = [
  "docStatus",
  "reviewedHelpHash",
  "reviewedLlamaCppCommit",
];

const validPresetSupport = new Set([
  "supported",
  "unsupported",
  "preset-only",
  "model-managed",
  "router-managed",
]);

type Issue = {
  path: string;
  severity: "error" | "warning";
  message: string;
};

function docFilesInDirectory() {
  return readdirSync(argumentDocsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => !name.startsWith("_") && name !== "README.md")
    .map((name) => resolve(argumentDocsDirectory, name))
    .sort((left, right) => left.localeCompare(right));
}

function changedDocFiles() {
  const root = resolve(argumentDocsDirectory, "..", "..", "..");
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACM",
      "HEAD",
      "--",
      "content/llama-args/llama-server",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path.endsWith(".md"))
    .filter((path) => !path.includes("/_") && !path.endsWith("/README.md"))
    .map((path) => resolve(root, path))
    .filter((path) => existsSync(path))
    .sort((left, right) => left.localeCompare(right));
}

function inputFiles() {
  const explicit = flagValue("--file");
  if (explicit) {
    return [resolve(explicit)];
  }
  if (hasFlag("--changed")) {
    return changedDocFiles();
  }
  return docFilesInDirectory();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function lintFile(path: string) {
  const issues: Issue[] = [];
  const raw = readFileSync(path, "utf8");
  const parsed = parseArgumentDocFile(raw);

  for (const key of requiredFrontmatter) {
    if (!(key in parsed.frontmatter)) {
      issues.push({
        path,
        severity: "error",
        message: `missing frontmatter field: ${key}`,
      });
    }
  }

  const summary = stringValue(parsed.frontmatter.summary);
  const presetSupport = stringValue(parsed.frontmatter.presetSupport);

  for (const key of obsoleteFrontmatter) {
    if (key in parsed.frontmatter) {
      issues.push({
        path,
        severity: "error",
        message: `obsolete frontmatter field: ${key}`,
      });
    }
  }

  if (presetSupport && !validPresetSupport.has(presetSupport)) {
    issues.push({
      path,
      severity: "error",
      message: `invalid presetSupport: ${presetSupport}`,
    });
  }

  const estimation = stringValue(parsed.frontmatter.estimation);
  if (
    estimation &&
    !LlamaArgumentEstimationSchema.safeParse(estimation).success
  ) {
    issues.push({
      path,
      severity: "error",
      message: `invalid estimation: ${estimation}`,
    });
  }

  if (
    !summary ||
    /чернов(ая|ой|ое)\s+инженерн/i.test(summary) ||
    /создан[а-я\s]+автоматически/i.test(summary)
  ) {
    issues.push({
      path,
      severity: "warning",
      message: "summary is empty or still reads like a draft",
    });
  }

  for (const pattern of stalePatterns) {
    if (pattern.test(raw)) {
      issues.push({
        path,
        severity: "error",
        message: `stale generated text matched ${pattern}`,
      });
    }
  }

  return issues;
}

const files = inputFiles();
const issues = files.flatMap(lintFile);
const errorCount = issues.filter((issue) => issue.severity === "error").length;
const warningCount = issues.filter(
  (issue) => issue.severity === "warning",
).length;

console.log(
  JSON.stringify(
    {
      checked: files.length,
      errors: errorCount,
      warnings: warningCount,
      issues,
    },
    null,
    2,
  ),
);

if (errorCount > 0 || (hasFlag("--strict") && warningCount > 0)) {
  process.exitCode = 1;
}
