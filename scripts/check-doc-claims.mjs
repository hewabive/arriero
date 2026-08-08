#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const workingDocuments = new Set(["docs/IMMUNE_REFACTOR.md"]);

const runtimePrefixes = ["config/", "data/", "runtime/", "tools/", "content/"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".sh", ".service"]);
const placeholderPattern = /[*<>?${}]/;
const pathClaimPattern = /`([A-Za-z0-9_@./-]+)`/g;
const symbolClaimPattern =
  /`([A-Za-z0-9_/.-]+\.tsx?):([A-Za-z_][A-Za-z0-9_]*)`/g;

const trackedFiles = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .split("\n")
  .filter((line) => line.length > 0);

function documents() {
  return trackedFiles
    .filter((file) => file.endsWith(".md"))
    .filter((file) => !file.startsWith("content/"))
    .filter((file) => !workingDocuments.has(file));
}

function withoutFencedBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function matchesBySuffix(rawClaim) {
  const claim = rawClaim.replace(/^\.\//, "");
  const suffix = claim.startsWith("/") ? claim : `/${claim}`;
  return trackedFiles.filter((file) => file === claim || file.endsWith(suffix));
}

function isCheckablePath(claim) {
  if (!claim.includes("/")) return false;
  if (placeholderPattern.test(claim)) return false;
  if (runtimePrefixes.some((prefix) => claim.startsWith(prefix))) return false;
  if (!sourceExtensions.has(path.extname(claim))) return false;
  return true;
}

const problems = [];

for (const document of documents()) {
  const raw = fs.readFileSync(path.join(root, document), "utf8");
  const prose = withoutFencedBlocks(raw);

  for (const match of prose.matchAll(pathClaimPattern)) {
    const claim = match[1];
    if (!isCheckablePath(claim)) continue;
    if (matchesBySuffix(claim).length > 0) continue;
    problems.push(
      `${document}:${lineOf(prose, match.index)} names a file that does not exist: ${claim}`,
    );
  }

  for (const match of prose.matchAll(symbolClaimPattern)) {
    const [, file, symbol] = match;
    const candidates = matchesBySuffix(file);
    if (candidates.length === 0) continue;
    const declared = new RegExp(`\\b${symbol}\\b`);
    const foundIn = candidates.some((candidate) =>
      declared.test(fs.readFileSync(path.join(root, candidate), "utf8")),
    );
    if (foundIn) continue;
    problems.push(
      `${document}:${lineOf(prose, match.index)} claims ${symbol} is in ${file}, but it is not there`,
    );
  }
}

if (problems.length > 0) {
  console.error("Documentation claims that no longer hold:");
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  console.error(
    `\n${problems.length} stale claim(s). Fix the doc, or the code it describes.`,
  );
  process.exit(1);
}

console.log(
  `Documentation claims check passed (${documents().length} documents).`,
);
