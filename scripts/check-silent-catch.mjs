#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listFiles, tsScanRoots } from "./lib/source-files.mjs";

const ENFORCING = false;

const root = process.cwd();
const scanRoots = tsScanRoots;
const extensions = new Set([".ts", ".tsx"]);
const testFilePattern = /\.test\.tsx?$/u;
const logMarkers = [
  "logger.",
  "console.",
  "onError",
  ".warn(",
  ".error(",
  "emitWarning",
];

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function forEachDescendant(node, visitor) {
  ts.forEachChild(node, (child) => {
    visitor(child);
    forEachDescendant(child, visitor);
  });
}

function forEachOwnScopeDescendant(node, visitor) {
  ts.forEachChild(node, (child) => {
    if (isFunctionLike(child) || ts.isClassLike(child)) {
      return;
    }

    visitor(child);
    forEachOwnScopeDescendant(child, visitor);
  });
}

function containsThrow(block) {
  let found = false;
  forEachDescendant(block, (node) => {
    if (ts.isThrowStatement(node)) {
      found = true;
    }
  });

  return found;
}

function looksLikeLogging(callExpression, sourceFile) {
  const signature = `${callExpression.expression.getText(sourceFile)}(`;
  return logMarkers.some((marker) => signature.includes(marker));
}

function containsLogCall(block, sourceFile) {
  let found = false;
  forEachDescendant(block, (node) => {
    if (ts.isCallExpression(node) && looksLikeLogging(node, sourceFile)) {
      found = true;
    }
  });

  return found;
}

function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

function catchBindingNames(catchClause) {
  const names = new Set();

  if (catchClause.variableDeclaration) {
    collectBindingNames(catchClause.variableDeclaration.name, names);
  }

  return names;
}

function usesBinding(node, bindings) {
  if (isFunctionLike(node) || ts.isClassLike(node)) {
    return false;
  }

  if (ts.isIdentifier(node)) {
    return bindings.has(node.text);
  }

  if (ts.isPropertyAccessExpression(node)) {
    return usesBinding(node.expression, bindings);
  }

  if (ts.isPropertyAssignment(node)) {
    return usesBinding(node.initializer, bindings);
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    found = found || usesBinding(child, bindings);
  });

  return found;
}

function passesBindingToCall(block, bindings) {
  if (bindings.size === 0) {
    return false;
  }

  let found = false;
  forEachOwnScopeDescendant(block, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.some((argument) => usesBinding(argument, bindings))
    ) {
      found = true;
    }
  });

  return found;
}

function unwrapExpression(expression) {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function isBareLiteral(expression) {
  const value = unwrapExpression(expression);

  if (
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }

  if (ts.isIdentifier(value) && value.text === "undefined") {
    return true;
  }

  if (ts.isVoidExpression(value)) {
    return true;
  }

  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.length === 0;
  }

  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.length === 0;
  }

  return false;
}

function ownScopeReturns(block) {
  const returns = [];
  forEachOwnScopeDescendant(block, (node) => {
    if (ts.isReturnStatement(node)) {
      returns.push(node);
    }
  });

  return returns;
}

function carriesFailure(block) {
  return ownScopeReturns(block).some(
    (statement) =>
      statement.expression !== undefined &&
      !isBareLiteral(statement.expression),
  );
}

function findingReason(block) {
  if (block.statements.length === 0) {
    return "empty catch block";
  }

  if (
    ownScopeReturns(block).some(
      (statement) => statement.expression !== undefined,
    )
  ) {
    return "returns a bare literal instead of the failure";
  }

  return "no rethrow, no log, no returned failure";
}

function lineText(sourceText, line) {
  return sourceText.split(/\r?\n/u)[line - 1]?.trim() ?? "";
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
  const findings = [];

  function visit(node) {
    if (ts.isCatchClause(node)) {
      const { block } = node;

      if (
        !containsThrow(block) &&
        !containsLogCall(block, sourceFile) &&
        !passesBindingToCall(block, catchBindingNames(node)) &&
        !carriesFailure(block)
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        findings.push({
          filePath,
          line: line + 1,
          column: character + 1,
          reason: findingReason(block),
          code: lineText(sourceText, line + 1),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

const filesByScanRoot = scanRoots.map((scanRoot) => ({
  scanRoot,
  files: listFiles(path.join(root, scanRoot), {
    extensions,
    exclude: testFilePattern,
  }),
}));
const files = filesByScanRoot.flatMap((entry) => entry.files);
const findings = files.flatMap(checkFile);

if (findings.length > 0) {
  const report = ENFORCING ? console.error : console.log;

  report(
    "Silent catch check: a catch that neither rethrows, nor logs, nor passes the error on, nor returns the failure.\n" +
      "Log through the shared logger (apps/api/src/logger.ts) or an injected onError, rethrow, hand the error to a caller, or return a typed failure.\n",
  );

  const byFile = new Map();
  for (const finding of findings) {
    const relativePath = path.relative(root, finding.filePath);
    const bucket = byFile.get(relativePath);
    if (bucket) {
      bucket.push(finding);
      continue;
    }

    byFile.set(relativePath, [finding]);
  }

  for (const [relativePath, fileFindings] of byFile) {
    report(`${relativePath} (${fileFindings.length})`);
    for (const finding of fileFindings) {
      report(
        `  ${relativePath}:${finding.line}:${finding.column} ${finding.reason}`,
      );
      report(`    ${finding.code}`);
    }
  }

  report("");
  for (const { scanRoot, files: scanRootFiles } of filesByScanRoot) {
    const scanRootPaths = new Set(scanRootFiles);
    const count = findings.filter((finding) =>
      scanRootPaths.has(finding.filePath),
    ).length;
    report(`${scanRoot}: ${count}`);
  }

  report(
    `\nSilent catch check found ${findings.length} sites in ${byFile.size} files (${files.length} files scanned).`,
  );

  if (ENFORCING) {
    process.exit(1);
  }

  console.log(
    `Advisory only — set ENFORCING = true in scripts/check-silent-catch.mjs once these ${findings.length} sites are gone.`,
  );
  process.exit(0);
}

console.log(`Silent catch check passed (${files.length} files).`);
