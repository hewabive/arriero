import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(
  process.argv[2] ?? resolve(root, "runtime/sources/llama.cpp"),
);
const header = resolve(source, "ggml/include/ggml.h");
const traitsFile = resolve(root, "packages/core/src/ggml.ts");

if (!existsSync(header)) {
  console.error(`llama.cpp ggml.h not found: ${header}`);
  console.error("Pass the current llama.cpp checkout as the first argument.");
  process.exitCode = 2;
} else {
  const upstream = new Map();
  const headerText = readFileSync(header, "utf8");
  for (const match of headerText.matchAll(
    /^\s*GGML_TYPE_([A-Z0-9_]+)\s*=\s*(\d+)\s*,/gm,
  )) {
    if (match[1] !== "COUNT") {
      upstream.set(Number(match[2]), match[1].toLowerCase());
    }
  }

  const local = new Map();
  const traitsText = readFileSync(traitsFile, "utf8");
  for (const match of traitsText.matchAll(
    /\{\s*id:\s*(\d+),\s*name:\s*"([^"]+)"/g,
  )) {
    local.set(Number(match[1]), match[2].toLowerCase());
  }

  const problems = [];
  for (const [id, name] of upstream) {
    const actual = local.get(id);
    if (actual === undefined) {
      problems.push(`missing upstream type ${id} (${name})`);
    } else if (actual !== name) {
      problems.push(`type ${id}: upstream=${name}, Arriero=${actual}`);
    }
  }
  for (const [id, name] of local) {
    if (!upstream.has(id)) {
      problems.push(`Arriero-only active type ${id} (${name})`);
    }
  }

  if (problems.length > 0) {
    console.error("GGML tensor type table differs from current llama.cpp:");
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(
      "Update blockSize/typeSize from upstream ggml type traits and add a row-size test before accepting estimates.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `GGML tensor type IDs/names match ${header} (${upstream.size} active types).`,
    );
  }
}
