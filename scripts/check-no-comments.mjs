#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const scanRoots = [
  "apps/api/src",
  "apps/web/src",
  "packages/core/src",
  "packages/anthropic-openai-bridge/src",
];
const extensions = new Set([".ts", ".tsx"]);
const commentKinds = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);
const allowedPragmas = [
  /@ts-expect-error/u,
  /@ts-ignore/u,
  /@ts-nocheck/u,
  /eslint-disable/u,
  /prettier-ignore/u,
  /@deprecated/u,
];

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
      continue;
    }

    if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function isAllowed(commentText) {
  return (
    commentText.startsWith("#!") ||
    allowedPragmas.some((pragma) => pragma.test(commentText))
  );
}

function firstLine(commentText) {
  const [line = ""] = commentText.split(/\r?\n/u);
  return line.trim();
}

function collectCommentRanges(node, sourceFile, sourceText, ranges) {
  const children = node.getChildren(sourceFile);

  if (children.length === 0) {
    for (const range of ts.getLeadingCommentRanges(
      sourceText,
      node.getFullStart(),
    ) ?? []) {
      ranges.set(range.pos, range);
    }

    for (const range of ts.getTrailingCommentRanges(
      sourceText,
      node.getEnd(),
    ) ?? []) {
      ranges.set(range.pos, range);
    }

    return;
  }

  for (const child of children) {
    collectCommentRanges(child, sourceFile, sourceText, ranges);
  }
}

function checkFile(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ranges = new Map();
  collectCommentRanges(sourceFile, sourceFile, sourceText, ranges);

  return [...ranges.values()]
    .filter((range) => commentKinds.has(range.kind))
    .map((range) => ({ range, text: sourceText.slice(range.pos, range.end) }))
    .filter(({ text }) => !isAllowed(text))
    .map(({ range, text }) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        range.pos,
      );
      return {
        filePath,
        line: line + 1,
        column: character + 1,
        text: firstLine(text),
      };
    })
    .sort(
      (left, right) => left.line - right.line || left.column - right.column,
    );
}

const files = scanRoots.flatMap((scanRoot) =>
  listFiles(path.join(root, scanRoot)),
);
const findings = files.flatMap(checkFile);

if (findings.length > 0) {
  console.error(
    "No-comments check failed.\n" +
      "Source code carries no comments (CLAUDE.md, categorical): express intent through names, small functions and types.\n" +
      "Non-obvious rationale belongs in a document under docs/, referenced from the surrounding documentation — never inline.\n" +
      "Only machine-readable annotations are allowed: @ts-expect-error, @ts-ignore, @ts-nocheck, eslint-disable, prettier-ignore, @deprecated, #! shebang.\n",
  );

  for (const finding of findings) {
    console.error(
      `${path.relative(root, finding.filePath)}:${finding.line}:${finding.column} comment`,
    );
    console.error(`  ${finding.text}`);
  }

  process.exit(1);
}

console.log(`No-comments check passed (${files.length} files).`);
