import { ArgumentOptionSchema } from "@arriero/core";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cachedGpuLayersDefault } from "./binary-defaults.js";
import { saveArgumentCatalog } from "./repository.js";

function gpuLayersOption(help: string) {
  return ArgumentOptionSchema.parse({
    primaryName: "--gpu-layers",
    names: ["-ngl", "--gpu-layers", "--n-gpu-layers"],
    category: "common",
    valueHint: "N",
    valueType: "number",
    env: ["LLAMA_ARG_N_GPU_LAYERS"],
    allowedValues: [],
    help,
    helpRu: "",
    helpRuSource: "fallback",
    deprecated: false,
  });
}

function saveCatalog(
  binaryPath: string,
  help: string,
  parserId = "llama-help",
) {
  saveArgumentCatalog({
    binaryPath,
    binarySize: 1,
    binaryMtimeMs: "1",
    binaryModifiedAt: "2026-08-17T00:00:00.000Z",
    helpHash: "test",
    options: [gpuLayersOption(help)],
    generatedAt: "2026-08-17T00:00:00.000Z",
    parserId,
  });
}

test("cachedGpuLayersDefault reads the help default from the catalog cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    const binaryPath = join(dir, "llama-server");
    saveCatalog(
      binaryPath,
      "max. number of layers to store in VRAM, either an exact number, 'auto', or 'all' (default: auto)",
    );
    assert.equal(cachedGpuLayersDefault(binaryPath), "auto");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedGpuLayersDefault is null without a default marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    const binaryPath = join(dir, "llama-server");
    saveCatalog(binaryPath, "number of layers to store in VRAM");
    assert.equal(cachedGpuLayersDefault(binaryPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cachedGpuLayersDefault is null for uncatalogued binaries and non-llama parsers", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-binary-defaults-"));
  try {
    assert.equal(cachedGpuLayersDefault(join(dir, "missing")), null);
    const vllmPath = join(dir, "vllm");
    saveCatalog(vllmPath, "layers (default: auto)", "vllm-help");
    assert.equal(cachedGpuLayersDefault(vllmPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
