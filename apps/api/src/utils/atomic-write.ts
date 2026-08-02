import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
