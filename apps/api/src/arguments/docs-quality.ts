import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import { flagValue, hasFlag } from "./cli-flags.js";
import { argumentDocFiles, argumentDocsDirectory } from "./docs.js";
import {
  engineDocContext,
  lintEngineArgumentDoc,
  lintLlamaArgumentDoc,
  type DocQualityIssue,
  type EngineDocCoverage,
} from "./docs-quality-lint.js";
import {
  engineArgumentContentPaths,
  readStoredEngineExtract,
} from "./engine-content.js";
import { listEngineArgumentReferences } from "./engine-reference.js";

type EngineDocs = {
  engineId: string;
  docsDirectory: string;
};

const engineDocs: EngineDocs[] = listEngineArgumentReferences().map(
  ({ engineId }) => ({
    engineId,
    docsDirectory: engineArgumentContentPaths(engineId).docsDirectory,
  }),
);

function engineOfPath(path: string) {
  return (
    engineDocs.find((engine) =>
      path.startsWith(`${engine.docsDirectory}${sep}`),
    ) ?? null
  );
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
      "content/engine-args",
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
    .filter(
      (path) =>
        path.startsWith(`${argumentDocsDirectory}${sep}`) ||
        engineOfPath(path) !== null,
    )
    .sort((left, right) => left.localeCompare(right));
}

function selectedFiles() {
  const explicit = flagValue("--file");
  if (explicit) {
    return [resolve(explicit)];
  }
  if (hasFlag("--changed")) {
    return changedDocFiles();
  }
  return null;
}

const selected = selectedFiles();
const issues: DocQualityIssue[] = [];
const coverage: EngineDocCoverage[] = [];

const llamaFiles =
  selected === null
    ? argumentDocFiles(argumentDocsDirectory)
    : selected.filter((path) => engineOfPath(path) === null);
let checked = llamaFiles.length;
issues.push(...llamaFiles.flatMap(lintLlamaArgumentDoc));

for (const engine of engineDocs) {
  const targeted =
    selected?.filter(
      (path) => engineOfPath(path)?.engineId === engine.engineId,
    ) ?? null;
  if (targeted && targeted.length === 0) {
    continue;
  }

  const files = targeted ?? argumentDocFiles(engine.docsDirectory);
  const stored = readStoredEngineExtract(engine.engineId);
  if (!stored.extract) {
    if (files.length > 0) {
      issues.push({
        path: stored.path,
        severity: "error",
        message: `stored argument extract for ${engine.engineId}: ${stored.error}`,
      });
    }
    continue;
  }

  const context = engineDocContext(engine.engineId, stored.extract);
  checked += files.length;
  issues.push(...files.flatMap((file) => lintEngineArgumentDoc(file, context)));
  if (!targeted) {
    coverage.push({
      engineId: engine.engineId,
      documented: files.length,
      total: stored.extract.options.length,
    });
  }
}

const errorCount = issues.filter((issue) => issue.severity === "error").length;
const warningCount = issues.filter(
  (issue) => issue.severity === "warning",
).length;

console.log(
  JSON.stringify(
    {
      checked,
      errors: errorCount,
      warnings: warningCount,
      engines: coverage,
      issues,
    },
    null,
    2,
  ),
);

if (errorCount > 0 || (hasFlag("--strict") && warningCount > 0)) {
  process.exitCode = 1;
}
