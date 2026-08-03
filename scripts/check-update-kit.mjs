import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siblingNames = ["llm-arena", "rag-manager"];

const kitFiles = [
  "apps/api/src/update/version.ts",
  "apps/api/src/update/runner.ts",
  "apps/api/src/update/repository.ts",
  "apps/api/src/update/logs.ts",
  "apps/api/src/update/version.test.ts",
  "apps/api/src/update/runner.test.ts",
  "apps/api/src/utils/log-tail.ts",
  "apps/api/src/jobs/store.ts",
  "apps/api/src/jobs/steps.ts",
  "apps/api/src/jobs/exec.ts",
  "apps/api/src/jobs/registry.ts",
  "apps/api/src/jobs/log-tail.ts",
  "apps/api/src/jobs/store.test.ts",
  "apps/api/src/jobs/steps.test.ts",
  "apps/api/src/jobs/exec.test.ts",
  "apps/api/src/jobs/registry.test.ts",
];

let failures = 0;

for (const sibling of siblingNames) {
  const siblingRoot = resolve(repoRoot, "..", sibling);
  if (!existsSync(siblingRoot)) {
    continue;
  }
  for (const file of kitFiles) {
    const ours = resolve(repoRoot, file);
    const theirs = resolve(siblingRoot, file);
    if (!existsSync(theirs)) {
      console.error(`missing in ${sibling}: ${file}`);
      failures += 1;
      continue;
    }
    if (!readFileSync(ours).equals(readFileSync(theirs))) {
      console.error(`differs in ${sibling}: ${file}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`update kit drift: ${failures} file(s) out of sync`);
  process.exit(1);
}
