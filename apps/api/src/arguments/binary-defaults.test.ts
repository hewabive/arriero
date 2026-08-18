import { ArgumentOptionSchema, type ArgumentOption } from "@arriero/core";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cachedGpuLayersDefaults } from "./binary-defaults.js";
import { saveArgumentCatalog } from "./repository.js";

function option(names: string[], help: string): ArgumentOption {
  return ArgumentOptionSchema.parse({
    primaryName: names[0],
    names,
    category: "common",
    valueHint: "N",
    valueType: "number",
    env: [],
    allowedValues: [],
    help,
    helpRu: "",
    helpRuSource: "fallback",
    deprecated: false,
  });
}

function saveCatalog(
  binaryPath: string,
  options: ArgumentOption[],
  parserId = "llama-help",
) {
  writeFileSync(binaryPath, `fake-binary:${binaryPath}`);
  const stat = statSync(binaryPath);
  saveArgumentCatalog({
    binaryPath,
    binarySize: stat.size,
    binaryMtimeMs: String(stat.mtimeMs),
    binaryModifiedAt: stat.mtime.toISOString(),
    helpHash: "test",
    options,
    generatedAt: "2026-08-17T00:00:00.000Z",
    parserId,
  });
}

test("cachedGpuLayersDefaults reads main and draft help defaults from the catalog cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    const binaryPath = join(dir, "llama-server");
    saveCatalog(binaryPath, [
      option(
        ["--gpu-layers", "-ngl", "--n-gpu-layers"],
        "max. number of layers to store in VRAM, either an exact number, 'auto', or 'all' (default: auto)",
      ),
      option(
        ["--spec-draft-ngl", "-ngld"],
        "max. number of draft model layers to store in VRAM (default: all)",
      ),
    ]);
    assert.deepEqual(cachedGpuLayersDefaults(binaryPath), {
      main: "auto",
      draft: "all",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedGpuLayersDefaults is null without a default marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    const binaryPath = join(dir, "llama-server");
    saveCatalog(binaryPath, [
      option(["--gpu-layers", "-ngl"], "number of layers to store in VRAM"),
    ]);
    assert.deepEqual(cachedGpuLayersDefaults(binaryPath), {
      main: null,
      draft: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedGpuLayersDefaults is null for uncatalogued binaries and non-llama parsers", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    assert.deepEqual(cachedGpuLayersDefaults(join(dir, "missing")), {
      main: null,
      draft: null,
    });
    assert.deepEqual(cachedGpuLayersDefaults(""), { main: null, draft: null });
    const vllmPath = join(dir, "vllm");
    saveCatalog(
      vllmPath,
      [option(["--gpu-layers"], "layers (default: auto)")],
      "vllm-help",
    );
    assert.deepEqual(cachedGpuLayersDefaults(vllmPath), {
      main: null,
      draft: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedGpuLayersDefaults rejects a catalog cached for a different binary build", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    const binaryPath = join(dir, "llama-server");
    saveCatalog(binaryPath, [
      option(["--gpu-layers", "-ngl"], "layers (default: auto)"),
    ]);
    assert.deepEqual(cachedGpuLayersDefaults(binaryPath), {
      main: "auto",
      draft: null,
    });
    writeFileSync(binaryPath, "rebuilt-binary-with-a-different-size");
    assert.deepEqual(cachedGpuLayersDefaults(binaryPath), {
      main: null,
      draft: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
