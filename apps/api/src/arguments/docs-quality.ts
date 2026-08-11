import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { flagValue, hasFlag } from "./cli-flags.js";
import { argumentDocsDirectory } from "./docs.js";
import {
  argumentDocFiles,
  engineDocContext,
  lintEngineArgumentDoc,
  lintEngineArgumentDocs,
  lintLlamaArgumentDoc,
  type DocQualityIssue,
  type EngineDocCoverage,
} from "./docs-quality-lint.js";
import { engineArgumentContentPaths } from "./engine-content.js";
import { listEngineArgumentReferences } from "./engine-reference.js";
import {
  parseEngineArgumentExtract,
  type ParsedExtract,
} from "./help-source.js";

type EngineDocs = {
  engineId: string;
  docsDirectory: string;
  snapshotPath: string;
};

const engineDocs: EngineDocs[] = listEngineArgumentReferences().map(
  ({ engineId }) => {
    const { docsDirectory, snapshotPath } =
      engineArgumentContentPaths(engineId);
    return { engineId, docsDirectory, snapshotPath };
  },
);

function engineOfPath(path: string) {
  return (
    engineDocs.find((engine) =>
      path.startsWith(`${engine.docsDirectory}${sep}`),
    ) ?? null
  );
}

function readStoredExtract(engine: EngineDocs): ParsedExtract {
  if (!existsSync(engine.snapshotPath)) {
    return { extract: null, error: "stored argument extract not found" };
  }
  return parseEngineArgumentExtract(readFileSync(engine.snapshotPath, "utf8"));
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

  const stored = readStoredExtract(engine);
  if (!stored.extract) {
    if ((targeted ?? argumentDocFiles(engine.docsDirectory)).length > 0) {
      issues.push({
        path: engine.snapshotPath,
        severity: "error",
        message: `stored argument extract for ${engine.engineId}: ${stored.error}`,
      });
    }
    continue;
  }

  if (targeted) {
    const context = engineDocContext(engine.engineId, stored.extract);
    checked += targeted.length;
    issues.push(
      ...targeted.flatMap((file) => lintEngineArgumentDoc(file, context)),
    );
    continue;
  }

  const linted = lintEngineArgumentDocs({
    engineId: engine.engineId,
    docsDirectory: engine.docsDirectory,
    extract: stored.extract,
  });
  checked += linted.files.length;
  issues.push(...linted.issues);
  coverage.push(linted.coverage);
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
