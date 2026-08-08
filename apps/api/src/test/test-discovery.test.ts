import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testFileSuffix = ".test.ts";

function testFilesOnDisk(relativeDir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(apiDir, relativeDir), {
    withFileTypes: true,
  })) {
    const entryPath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...testFilesOnDisk(entryPath));
    } else if (entry.name.endsWith(testFileSuffix)) {
      found.push(entryPath);
    }
  }
  return found;
}

function pathArgumentsOfTestScript(): string {
  const manifest = JSON.parse(
    readFileSync(join(apiDir, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const script = manifest.scripts.test;
  assert.ok(script, "apps/api has no test script");
  const flagIndex = script.indexOf("--test ");
  assert.notEqual(flagIndex, -1, "the test script does not pass --test");
  return script.slice(flagIndex + "--test ".length).trim();
}

function afterShellExpansion(pathArguments: string): string[] {
  const probe = `set -- ${pathArguments}; printf '%s\\n' "$@"`;
  return execFileSync("/bin/sh", ["-c", probe], {
    cwd: apiDir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

function reachedByTestRunner(): string[] {
  const reached = new Set<string>();
  for (const argument of afterShellExpansion(pathArgumentsOfTestScript())) {
    if (argument.includes("*")) {
      for (const match of globSync(argument, { cwd: apiDir })) {
        reached.add(match.split("\\").join("/"));
      }
    } else {
      reached.add(argument);
    }
  }
  return [...reached];
}

test("the test script reaches every test file on disk", () => {
  const reached = reachedByTestRunner().sort();
  const onDisk = testFilesOnDisk("src").sort();
  const unreachable = onDisk.filter((file) => !reached.includes(file));
  assert.deepEqual(
    unreachable,
    [],
    `these test files are never executed by "pnpm test": ${unreachable.join(", ")}`,
  );
  assert.deepEqual(reached, onDisk);
});
