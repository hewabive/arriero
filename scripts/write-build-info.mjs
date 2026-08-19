import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function currentCommit() {
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const distDir = resolve(repoRoot, "apps/api/dist");
mkdirSync(distDir, { recursive: true });
const info = { commit: currentCommit(), builtAt: new Date().toISOString() };
writeFileSync(
  resolve(distDir, "build-info.json"),
  `${JSON.stringify(info, null, 2)}\n`,
);
console.log(`build-info stamped: ${info.commit ?? "commit unknown"}`);
