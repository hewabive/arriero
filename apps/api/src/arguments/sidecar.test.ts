import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { binaryStat } from "./binary-discovery.js";
import { getArgumentCatalogAsync } from "./catalog.js";
import { parseLlamaArgumentOptions } from "./help-parser.js";
import {
  getCachedArgumentCatalog,
  saveArgumentCatalog,
  type CachedArgumentCatalog,
} from "./repository.js";
import {
  argumentCatalogSidecarPath,
  readArgumentCatalogSidecar,
  writeArgumentCatalogSidecar,
} from "./sidecar.js";

function sampleCatalog(binaryPath: string): CachedArgumentCatalog {
  const options = parseLlamaArgumentOptions(`
----- common params -----
--model FNAME                           model path to load
-ngl,  --gpu-layers N                   layers in VRAM
`);
  return {
    binaryPath,
    binarySize: 1234,
    binaryMtimeMs: "100.5",
    binaryModifiedAt: "2026-01-01T00:00:00.000Z",
    helpHash: "deadbeef",
    options,
    generatedAt: "2026-01-01T00:00:00.000Z",
    parserId: "llama-help",
  };
}

test("argument catalog sidecar round-trips and respects binary stat", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-args-sidecar-"));
  try {
    const binaryPath = join(dir, "llama-server");
    const catalog = sampleCatalog(binaryPath);
    writeArgumentCatalogSidecar(catalog);

    const stat = {
      binarySize: 1234,
      binaryMtimeMs: "100.5",
      binaryModifiedAt: "2026-01-01T00:00:00.000Z",
    };
    const loaded = readArgumentCatalogSidecar(binaryPath, stat);
    assert.ok(loaded);
    assert.equal(loaded?.helpHash, "deadbeef");
    assert.equal(loaded?.parserId, "llama-help");
    assert.equal(loaded?.binaryPath, binaryPath);
    assert.deepEqual(
      loaded?.options.map((option) => option.primaryName),
      catalog.options.map((option) => option.primaryName),
    );

    assert.equal(
      readArgumentCatalogSidecar(binaryPath, {
        ...stat,
        binaryMtimeMs: "200.0",
      }),
      null,
    );
    assert.equal(
      readArgumentCatalogSidecar(binaryPath, { ...stat, binarySize: 9999 }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("argument catalog sidecar reads the v1 format as the llama-help parser", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-args-sidecar-"));
  try {
    const binaryPath = join(dir, "llama-server");
    const catalog = sampleCatalog(binaryPath);
    writeFileSync(
      argumentCatalogSidecarPath(binaryPath),
      JSON.stringify({
        version: 1,
        binarySize: catalog.binarySize,
        binaryMtimeMs: catalog.binaryMtimeMs,
        binaryModifiedAt: catalog.binaryModifiedAt,
        helpHash: catalog.helpHash,
        generatedAt: catalog.generatedAt,
        options: catalog.options,
      }),
      "utf8",
    );

    const loaded = readArgumentCatalogSidecar(binaryPath, {
      binarySize: catalog.binarySize,
      binaryMtimeMs: catalog.binaryMtimeMs,
      binaryModifiedAt: catalog.binaryModifiedAt,
    });
    assert.ok(loaded);
    assert.equal(loaded?.parserId, "llama-help");
    assert.equal(loaded?.helpHash, catalog.helpHash);

    assert.equal(
      readArgumentCatalogSidecar(binaryPath, {
        binarySize: catalog.binarySize,
        binaryMtimeMs: "999.0",
        binaryModifiedAt: catalog.binaryModifiedAt,
      }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("argument catalog sidecar read returns null when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-args-sidecar-"));
  try {
    assert.equal(
      readArgumentCatalogSidecar(join(dir, "missing"), {
        binarySize: 1,
        binaryMtimeMs: "1",
        binaryModifiedAt: "2026-01-01T00:00:00.000Z",
      }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("argument catalog sidecar path is hidden and per-binary", () => {
  assert.equal(
    argumentCatalogSidecarPath("/x/bin/llama-server"),
    "/x/bin/.llama-server.llama-args.json",
  );
});

test("getArgumentCatalogAsync regenerates a cache row with a mismatching parser id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-args-parser-miss-"));
  try {
    const binaryPath = join(dir, "llama-server");
    writeFileSync(
      binaryPath,
      [
        "#!/bin/sh",
        'echo "----- common params -----"',
        'echo "--model FNAME                           model path to load"',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(binaryPath, 0o755);
    const stat = binaryStat(binaryPath);
    saveArgumentCatalog({
      binaryPath,
      binarySize: stat.binarySize,
      binaryMtimeMs: stat.binaryMtimeMs,
      binaryModifiedAt: stat.binaryModifiedAt,
      helpHash: "legacy-hash",
      options: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
      parserId: "legacy",
    });

    const catalog = await getArgumentCatalogAsync(binaryPath);
    assert.equal(catalog.cache.hit, false);
    assert.equal(catalog.cache.refreshed, true);
    assert.equal(catalog.cache.stale, true);
    assert.ok(
      catalog.options.some((option) => option.primaryName === "--model"),
    );
    assert.equal(getCachedArgumentCatalog(binaryPath)?.parserId, "llama-help");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getArgumentCatalogAsync hydrates the DB from the sidecar without running the binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-args-hydrate-"));
  try {
    const binaryPath = join(dir, "llama-server");
    writeFileSync(binaryPath, "#!/bin/false\n", "utf8");
    const stat = binaryStat(binaryPath);
    writeArgumentCatalogSidecar({
      binaryPath,
      binarySize: stat.binarySize,
      binaryMtimeMs: stat.binaryMtimeMs,
      binaryModifiedAt: stat.binaryModifiedAt,
      helpHash: "abc123",
      options: parseLlamaArgumentOptions(`
----- common params -----
--model FNAME                           model path to load
`),
      generatedAt: "2026-01-01T00:00:00.000Z",
      parserId: "llama-help",
    });

    assert.equal(getCachedArgumentCatalog(binaryPath), null);

    const catalog = await getArgumentCatalogAsync(binaryPath);
    assert.equal(catalog.cache.hit, true);
    assert.equal(catalog.cache.refreshed, false);
    assert.equal(catalog.source.hash, "abc123");
    assert.ok(
      catalog.options.some((option) => option.primaryName === "--model"),
    );
    assert.ok(getCachedArgumentCatalog(binaryPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getArgumentCatalogAsync regenerates duplicate primary names from cache and sidecar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-args-duplicates-"));
  try {
    const binaryPath = join(dir, "vllm");
    writeFileSync(
      binaryPath,
      [
        "#!/bin/sh",
        'echo "usage: vllm serve [model_tag] [options]"',
        'echo "options:"',
        'echo "  --host HOST           Host name"',
        'echo "  --port PORT           Port"',
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(binaryPath, 0o755);
    const stat = binaryStat(binaryPath);
    const duplicate = parseLlamaArgumentOptions(`
----- examples -----
--json-arg JSON                        first example
--json-arg JSON                        second example
`);
    const stale = {
      binaryPath,
      binarySize: stat.binarySize,
      binaryMtimeMs: stat.binaryMtimeMs,
      binaryModifiedAt: stat.binaryModifiedAt,
      helpHash: "duplicate-hash",
      options: duplicate,
      generatedAt: "2026-01-01T00:00:00.000Z",
      parserId: "vllm-help",
    };
    saveArgumentCatalog(stale);
    writeArgumentCatalogSidecar(stale);

    const catalog = await getArgumentCatalogAsync(binaryPath, {
      parserId: "vllm-help",
    });
    const primaryNames = catalog.options.map((option) => option.primaryName);
    assert.equal(catalog.cache.hit, false);
    assert.equal(catalog.cache.refreshed, true);
    assert.equal(catalog.cache.stale, true);
    assert.equal(new Set(primaryNames).size, primaryNames.length);
    assert.deepEqual(primaryNames, ["--host", "--port"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vLLM catalog falls back when runtime help cannot initialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-vllm-fallback-"));
  try {
    const binaryPath = join(dir, "vllm");
    writeFileSync(
      binaryPath,
      "#!/bin/sh\necho 'CUDA platform unavailable' >&2\nexit 1\n",
      "utf8",
    );
    chmodSync(binaryPath, 0o755);

    const catalog = await getArgumentCatalogAsync(binaryPath, {
      parserId: "vllm-help",
      refresh: true,
    });

    assert.deepEqual(catalog.source.command, [
      "arriero",
      "vllm-fallback-catalog",
    ]);
    assert.ok(catalog.source.hash.startsWith("fallback:"));
    assert.ok(
      catalog.options.some((option) => option.primaryName === "--device"),
    );
    assert.ok(
      catalog.options.some(
        (option) => option.primaryName === "--tensor-parallel-size",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SGLang catalog falls back when runtime help cannot initialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-sglang-fallback-"));
  try {
    const binaryPath = join(dir, "sglang");
    writeFileSync(
      binaryPath,
      "#!/bin/sh\necho 'CUDA platform unavailable' >&2\nexit 1\n",
      "utf8",
    );
    chmodSync(binaryPath, 0o755);

    const catalog = await getArgumentCatalogAsync(binaryPath, {
      parserId: "sglang-help",
      refresh: true,
    });

    assert.deepEqual(catalog.source.command, [
      "arriero",
      "sglang-fallback-catalog",
    ]);
    assert.ok(catalog.source.hash.startsWith("fallback:"));
    assert.ok(
      catalog.options.some(
        (option) => option.primaryName === "--kt-weight-path",
      ),
    );
    assert.ok(
      catalog.options.some(
        (option) => option.primaryName === "--max-running-requests",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SGLang catalog reads language-server help through the environment Python", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-sglang-live-help-"));
  try {
    const binaryPath = join(dir, "sglang");
    const pythonPath = join(dir, "python");
    writeFileSync(binaryPath, "#!/bin/sh\nexit 99\n", "utf8");
    writeFileSync(
      pythonPath,
      `#!/bin/sh
test "$1" = "-m"
test "$2" = "sglang.launch_server"
test "$3" = "--help"
printf '%s\\n' 'usage: launch_server.py [options]' \
  'KTransformers:' \
  '  --kt-weight-path KT_WEIGHT_PATH' \
  '                               CPU weight directory'
`,
      "utf8",
    );
    chmodSync(binaryPath, 0o755);
    chmodSync(pythonPath, 0o755);

    const catalog = await getArgumentCatalogAsync(binaryPath, {
      parserId: "sglang-help",
      refresh: true,
    });

    assert.deepEqual(catalog.source.command, [
      pythonPath,
      "-m",
      "sglang.launch_server",
      "--help",
    ]);
    assert.ok(!catalog.source.hash.startsWith("fallback:"));
    assert.ok(
      catalog.options.some(
        (option) => option.primaryName === "--kt-weight-path",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
