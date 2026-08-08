import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siblingNames = ["llm-arena", "rag-manager"];
const jobsKernelDir = "apps/api/src/jobs";

const repoSpecificFiles = ["apps/api/src/update/adapter.ts"];

const sharedUpdateFiles = [
  "apps/api/src/update/version.ts",
  "apps/api/src/update/runner.ts",
  "apps/api/src/update/repository.ts",
  "apps/api/src/update/logs.ts",
  "apps/api/src/update/version.test.ts",
  "apps/api/src/update/runner.test.ts",
  "apps/api/src/utils/log-tail.ts",
];

function jobsKernelFiles() {
  return readdirSync(resolve(repoRoot, jobsKernelDir))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `${jobsKernelDir}/${name}`);
}

const kitFiles = [...sharedUpdateFiles, ...jobsKernelFiles()].filter(
  (file) => !repoSpecificFiles.includes(file),
);

let failures = 0;
let comparedSiblings = 0;

for (const sibling of siblingNames) {
  const siblingRoot = resolve(repoRoot, "..", sibling);
  if (!existsSync(siblingRoot)) {
    console.error(`sibling checkout not found, cannot compare: ${siblingRoot}`);
    continue;
  }
  comparedSiblings += 1;
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

if (comparedSiblings === 0) {
  console.error(
    `update kit unverified: none of [${siblingNames.join(", ")}] is checked out beside ${repoRoot}`,
  );
  process.exit(2);
}

if (failures > 0) {
  console.error(`update kit drift: ${failures} file(s) out of sync`);
  process.exit(1);
}

console.log(
  `update kit matches ${comparedSiblings} sibling checkout(s) across ${kitFiles.length} files.`,
);
