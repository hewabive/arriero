#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const exampleFile = ".env.example";
const prefix = "ARRIERO_";

const internalVariables = new Set([
  "ARRIERO_TEST_ROOT",
  "ARRIERO_ENV_TEST_BOTH",
  "ARRIERO_ENV_TEST_EMPTY",
  "ARRIERO_ENV_TEST_LEGACY",
  "ARRIERO_ENV_TEST_UNSET",
]);

const nonEnvironmentNames = new Set(["ARRIERO_HELP", "ARRIERO_KT_RUNTIME"]);

const literalPattern = /\bARRIERO_[A-Z0-9_]+\b/g;
const helperPattern =
  /\b(?:managerEnv|managedPath|envPath)\(\s*"([A-Z0-9_]+)"/g;

function sourceFiles() {
  return execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

function variablesReadByCode() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(literalPattern)) {
      if (!found.has(match[0])) found.set(match[0], file);
    }
    for (const match of text.matchAll(helperPattern)) {
      const name = `${prefix}${match[1]}`;
      if (!found.has(name)) found.set(name, file);
    }
  }
  return found;
}

function variablesInExample() {
  const text = fs.readFileSync(path.join(root, exampleFile), "utf8");
  return new Set(text.match(literalPattern) ?? []);
}

const read = variablesReadByCode();
const documented = variablesInExample();
const problems = [];

for (const [name, file] of [...read].sort()) {
  if (internalVariables.has(name) || nonEnvironmentNames.has(name)) continue;
  if (documented.has(name)) continue;
  problems.push(`${name} is read in ${file} but is absent from ${exampleFile}`);
}

for (const name of [...documented].sort()) {
  if (read.has(name)) continue;
  problems.push(
    `${name} is documented in ${exampleFile} but nothing reads it (check managerEnv/managedPath spelling before deleting)`,
  );
}

if (problems.length > 0) {
  console.error(`${exampleFile} is out of sync with the code:`);
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log(
  `${exampleFile} documents every operator-facing variable (${documented.size} documented, ${internalVariables.size} internal, ${nonEnvironmentNames.size} lookalike names ignored).`,
);
