#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listFiles } from "./lib/source-files.mjs";

const root = process.cwd();
const scanRoots = ["apps/web/src"];
const eventProperties = new Set(["currentTarget", "target"]);
const extensions = new Set([".ts", ".tsx"]);

function functionParams(node) {
  const params = new Set();

  for (const param of node.parameters ?? []) {
    if (ts.isIdentifier(param.name)) {
      params.add(param.name.text);
    }
  }

  return params;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function closestParamScope(functionStack, name) {
  for (let index = functionStack.length - 1; index >= 0; index -= 1) {
    if (functionStack[index].params.has(name)) {
      return index;
    }
  }

  return -1;
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
  const functionStack = [];

  function visit(node) {
    if (isFunctionLike(node)) {
      functionStack.push({ node, params: functionParams(node) });
      ts.forEachChild(node, visit);
      functionStack.pop();
      return;
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      eventProperties.has(node.name.text)
    ) {
      const paramScopeIndex = closestParamScope(
        functionStack,
        node.expression.text,
      );
      const currentScopeIndex = functionStack.length - 1;

      if (paramScopeIndex >= 0 && paramScopeIndex < currentScopeIndex) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        findings.push({
          filePath,
          line: line + 1,
          column: character + 1,
          property: node.name.text,
          code: lineText(sourceText, line + 1),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

const files = scanRoots.flatMap((scanRoot) =>
  listFiles(path.join(root, scanRoot), { extensions }),
);
const findings = files.flatMap(checkFile);

if (findings.length > 0) {
  console.error(
    "React event capture check failed.\n" +
      "Read event.currentTarget/event.target into a local value before passing it into setState updaters, timers, promises, or other nested callbacks.\n",
  );

  for (const finding of findings) {
    console.error(
      `${path.relative(root, finding.filePath)}:${finding.line}:${finding.column} uses event.${finding.property} from an outer callback`,
    );
    console.error(`  ${finding.code}`);
  }

  process.exit(1);
}

console.log(`React event capture check passed (${files.length} files).`);
