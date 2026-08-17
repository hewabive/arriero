import { ArgumentOptionSchema } from "@arriero/core";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getArgumentCatalogAsync,
  parseLlamaArgumentOptions,
} from "./catalog.js";
import { saveArgumentCatalog } from "./repository.js";

function optionMap(help: string) {
  return new Map(
    parseLlamaArgumentOptions(help).map((option) => [
      option.primaryName,
      option,
    ]),
  );
}

test("parseLlamaArgumentOptions keeps long boolean and numeric options out of list type", () => {
  const options = optionMap(`
----- common params -----
--help, -h                              print usage and exit
-dio,  --direct-io, -ndio, --no-direct-io
                                        use DirectIO if available. (default: disabled)
                                        (env: LLAMA_ARG_DIO)
-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,
                                        'auto', or 'all' (default: auto)
                                        (env: LLAMA_ARG_N_GPU_LAYERS)
`);

  assert.equal(options.get("--help")?.valueType, "flag");
  assert.equal(options.get("--direct-io")?.valueType, "boolean");
  assert.equal(options.get("--gpu-layers")?.valueType, "number");
  assert.equal(options.get("--gpu-layers")?.valueHint, "N");
});

test("parseLlamaArgumentOptions detects comma-separated list options", () => {
  const options = optionMap(`
----- common params -----
-dev,  --device <dev1,dev2,..>          comma-separated list of devices to use for offloading (none = don't
                                        offload)
                                        use --list-devices to see a list of available devices
                                        (env: LLAMA_ARG_DEVICE)
-fitt, --fit-target MiB0,MiB1,MiB2,...
                                        target margin per device for --fit, comma-separated list of values,
                                        single value is broadcast across all devices, default: 1024
                                        (env: LLAMA_ARG_FIT_TARGET)
--rpc SERVERS                           comma separated list of RPC servers (host:port)
                                        (env: LLAMA_ARG_RPC)
--tools TOOL1,TOOL2,...                 experimental: whether to enable built-in tools for AI agents
--lora FNAME                            path to LoRA adapter (use comma-separated values to load multiple
                                        adapters)
--model FNAME                           model path to load
`);

  assert.equal(options.get("--device")?.valueType, "list");
  assert.equal(options.get("--fit-target")?.valueType, "list");
  assert.equal(options.get("--rpc")?.valueType, "list");
  assert.equal(options.get("--tools")?.valueType, "list");
  assert.equal(options.get("--lora")?.valueType, "list");
  assert.equal(options.get("--model")?.valueType, "path");
});

test("the docs-free catalog variant keeps compatibility and skips doc attachment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-catalog-"));
  const binaryPath = join(directory, "llama-server");
  writeFileSync(binaryPath, "fake-llama-server");
  const stat = statSync(binaryPath);
  const option = ArgumentOptionSchema.parse({
    primaryName: "--ctx-size",
    names: ["--ctx-size", "-c"],
    category: "common",
    valueHint: "N",
    valueType: "number",
    env: [],
    allowedValues: [],
    help: "size of the prompt context (default: 4096)",
    helpRu: "",
    helpRuSource: "fallback",
    deprecated: false,
  });
  saveArgumentCatalog({
    binaryPath,
    binarySize: stat.size,
    binaryMtimeMs: String(stat.mtimeMs),
    binaryModifiedAt: stat.mtime.toISOString(),
    helpHash: "test-help-hash",
    options: [option],
    generatedAt: new Date().toISOString(),
    parserId: "llama-help",
  });
  try {
    const withoutDocs = await getArgumentCatalogAsync(binaryPath, {
      docs: false,
    });
    assert.equal(withoutDocs.cache.hit, true);
    assert.equal(
      withoutDocs.options.some((entry) => entry.doc.exists),
      false,
    );
    const ctx = withoutDocs.options.find(
      (entry) => entry.primaryName === "--ctx-size",
    );
    assert.equal(ctx?.compatibility.presentInBinary, true);
    assert.deepEqual(ctx?.compatibility.binaryNames, ["--ctx-size", "-c"]);
    const withDocs = await getArgumentCatalogAsync(binaryPath);
    assert.equal(withDocs.cache.hit, true);
    assert.equal(
      withDocs.options.some((entry) => entry.doc.exists),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
