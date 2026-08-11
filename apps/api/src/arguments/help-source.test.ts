import type { EngineArgumentExtract } from "@arriero/core";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createExtractHelpSourceAdapter } from "./help-source-adapters.js";
import {
  diffEngineArgumentExtracts,
  engineArgumentSurfaceHash,
  parseEngineArgumentExtract,
} from "./help-source.js";

function extract(
  options: Partial<EngineArgumentExtract["options"][number]>[],
): EngineArgumentExtract {
  return {
    schema: 1,
    engine: "vllm",
    entrypoint: "vllm serve",
    sourceFiles: ["vllm/engine/arg_utils.py"],
    options: options.map((option) => ({
      flags: ["--flag"],
      group: null,
      help: "",
      choices: null,
      type: null,
      default: null,
      action: null,
      hidden: false,
      origin: "vllm/config/model.py:ModelConfig.field",
      ...option,
    })),
  };
}

describe("parseEngineArgumentExtract", () => {
  it("reports malformed JSON instead of throwing", () => {
    const parsed = parseEngineArgumentExtract("{not json");
    assert.equal(parsed.extract, null);
    assert.match(parsed.error ?? "", /not valid JSON/);
  });

  it("reports a schema mismatch instead of accepting a partial extract", () => {
    const parsed = parseEngineArgumentExtract(
      JSON.stringify({ schema: 1, engine: "vllm" }),
    );
    assert.equal(parsed.extract, null);
    assert.match(parsed.error ?? "", /does not match the schema/);
  });

  it("accepts an extract produced by the repository extractors", () => {
    const parsed = parseEngineArgumentExtract(JSON.stringify(extract([{}])));
    assert.equal(parsed.error, null);
    assert.equal(parsed.extract?.options.length, 1);
  });
});

describe("engineArgumentSurfaceHash", () => {
  it("ignores declaration origin so a moved declaration is not a drift signal", () => {
    const left = extract([{ flags: ["--model"], help: "Model." }]);
    const right = extract([
      {
        flags: ["--model"],
        help: "Model.",
        origin: "vllm/config/moved.py:X.y",
      },
    ]);
    assert.equal(
      engineArgumentSurfaceHash(left),
      engineArgumentSurfaceHash(right),
    );
  });

  it("changes when help text changes", () => {
    const left = extract([{ flags: ["--model"], help: "Model." }]);
    const right = extract([{ flags: ["--model"], help: "Model path." }]);
    assert.notEqual(
      engineArgumentSurfaceHash(left),
      engineArgumentSurfaceHash(right),
    );
  });

  it("changes when a choice is added", () => {
    const left = extract([{ flags: ["--dtype"], choices: ["auto"] }]);
    const right = extract([{ flags: ["--dtype"], choices: ["auto", "half"] }]);
    assert.notEqual(
      engineArgumentSurfaceHash(left),
      engineArgumentSurfaceHash(right),
    );
  });

  it("is stable across repeated serialization", () => {
    const value = extract([{ flags: ["--model"] }]);
    const roundTripped = parseEngineArgumentExtract(JSON.stringify(value));
    assert.equal(
      engineArgumentSurfaceHash(value),
      engineArgumentSurfaceHash(roundTripped.extract!),
    );
  });
});

describe("diffEngineArgumentExtracts", () => {
  it("reports added, removed and changed arguments", () => {
    const stored = extract([
      { flags: ["--model"], help: "Model." },
      { flags: ["--gone"], help: "Removed." },
    ]);
    const current = extract([
      { flags: ["--model"], help: "Model path.", group: "ModelConfig" },
      { flags: ["--new"], help: "Added.", group: "ModelConfig" },
    ]);

    const diff = diffEngineArgumentExtracts(stored, current);
    assert.match(diff, /^\+ --new \(ModelConfig\)$/m);
    assert.match(diff, /^- --gone$/m);
    assert.match(diff, /^~ --model$/m);
    assert.match(diff, /help: Model\. -> Model path\./);
    assert.match(diff, /group: none -> ModelConfig/);
  });

  it("points at the changed fragment of a long help text", () => {
    const shared = "A ".repeat(120);
    const stored = extract([
      { flags: ["--model"], help: `${shared}old tail.` },
    ]);
    const current = extract([
      { flags: ["--model"], help: `${shared}new tail.` },
    ]);

    const diff = diffEngineArgumentExtracts(stored, current);
    assert.match(diff, /\[old\] tail\. -> …[^\n]*\[new\] tail\./);
    assert.ok(
      diff.length < shared.length,
      "the shared prefix is trimmed from the diff",
    );
  });

  it("stays quiet when only the origin moved", () => {
    const stored = extract([{ flags: ["--model"], origin: "a.py:A.b" }]);
    const current = extract([{ flags: ["--model"], origin: "b.py:B.c" }]);
    assert.equal(
      diffEngineArgumentExtracts(stored, current),
      "No argument declaration changes.",
    );
  });

  it("describes the current extract when no snapshot is stored", () => {
    const diff = diffEngineArgumentExtracts(null, extract([{}, {}]));
    assert.match(diff, /2 arguments in vllm serve/);
  });
});

describe("repository extractors", () => {
  it("produce output the core schema accepts", () => {
    const directory = mkdtempSync(join(tmpdir(), "arriero-extract-"));
    const path = join(directory, "extract.json");
    writeFileSync(
      path,
      JSON.stringify(extract([{ flags: ["--model"] }])),
      "utf8",
    );
    const parsed = parseEngineArgumentExtract(readFileSync(path, "utf8"));
    assert.equal(parsed.error, null);
    assert.equal(parsed.extract?.entrypoint, "vllm serve");
  });
});

function testAdapter(
  run: () => Promise<
    { payload: string; error: null } | { payload: null; error: string }
  >,
  calls = { count: 0 },
) {
  return createExtractHelpSourceAdapter({
    id: "vllm-adapter-test",
    displayName: "vLLM test",
    sourceId: "vllm",
    script: "vllm.py",
    sourcePaths: ["vllm/engine/arg_utils.py"],
    runner: async () => {
      calls.count += 1;
      return run();
    },
  });
}

describe("declaration extract adapter", () => {
  it("reports an absent snapshot without claiming the source is in sync", async () => {
    const sync = await testAdapter(async () => ({
      payload: JSON.stringify(extract([{ flags: ["--model"] }])),
      error: null,
    })).sync();

    assert.equal(sync.kind, "declaration-extract");
    assert.equal(sync.stored.exists, false);
    assert.match(sync.stored.error ?? "", /stored argument extract not found/);
    assert.notEqual(sync.current.hash, null);
    assert.equal(sync.inSync, null);
  });

  it("surfaces an extractor failure as the current-side error", async () => {
    const sync = await testAdapter(async () => ({
      payload: null,
      error:
        "python3 not found in PATH; the argument declaration cannot be extracted on this host",
    })).sync();

    assert.equal(sync.current.hash, null);
    assert.match(sync.current.error ?? "", /python3 not found/);
    assert.equal(sync.inSync, null);
  });

  it("rejects extractor output that does not match the schema", async () => {
    const sync = await testAdapter(async () => ({
      payload: JSON.stringify({ schema: 1, engine: "vllm" }),
      error: null,
    })).sync();

    assert.equal(sync.current.hash, null);
    assert.match(sync.current.error ?? "", /does not match the schema/);
  });

  it("reuses the extractor result within its cache window", async () => {
    const calls = { count: 0 };
    const adapter = testAdapter(
      async () => ({
        payload: JSON.stringify(extract([{ flags: ["--model"] }])),
        error: null,
      }),
      calls,
    );

    await adapter.sync();
    await adapter.sync();
    assert.equal(calls.count, 1);
  });

  it("refuses to write a snapshot when the extractor failed", async () => {
    const adapter = testAdapter(async () => ({
      payload: null,
      error: "extractor failed: SystemExit",
    }));
    await assert.rejects(() => adapter.write(), /extractor failed/);
  });
});
