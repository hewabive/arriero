#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { trackedFiles } from "./lib/source-files.mjs";

const root = process.cwd();

function lineOf(data, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (data[i] === 10) line += 1;
  }
  return line;
}

const problems = [];
let scanned = 0;

for (const file of trackedFiles(root)) {
  let data;
  try {
    data = fs.readFileSync(path.join(root, file));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  scanned += 1;
  const offset = data.indexOf(0);
  if (offset === -1) continue;
  problems.push(
    `${file}:${lineOf(data, offset)} contains a raw NUL byte (offset ${offset}); git will treat the file as binary — use the "\\0" escape in string literals instead`,
  );
}

if (problems.length > 0) {
  console.error("NUL bytes found in repository files:");
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log(`NUL-byte check passed (${scanned} files).`);
