import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readGgufFactsOffThread,
  readGgufModelTensorTableOffThread,
  stopGgufWorker,
} from "./gguf-worker-client.js";
import { readGgufFacts } from "./gguf.js";

function u32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function ggufString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function syntheticModel() {
  const kv = Buffer.concat([
    ggufString("general.architecture"),
    u32(8),
    ggufString("qwen35"),
  ]);
  const tensor = Buffer.concat([
    ggufString("blk.0.ffn_down.weight"),
    u32(2),
    u64(32),
    u64(8),
    u32(12),
    u64(0),
  ]);
  return Buffer.concat([
    Buffer.from("GGUF", "utf8"),
    u32(3),
    u64(1),
    u64(1),
    kv,
    tensor,
  ]);
}

test("the gguf worker returns the same facts as an in-process parse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-worker-"));
  const path = join(dir, "worker.gguf");
  try {
    writeFileSync(path, syntheticModel());

    const facts = await readGgufFactsOffThread(path);
    assert.deepEqual(facts, readGgufFacts(path));

    const table = await readGgufModelTensorTableOffThread(path);
    assert.equal(table.tensorCount, 1);
    assert.equal(table.tensors[0]?.name, "blk.0.ffn_down.weight");
  } finally {
    await stopGgufWorker();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken GGUF rejects through the worker and keeps it usable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-gguf-worker-broken-"));
  const broken = join(dir, "broken.gguf");
  const valid = join(dir, "valid.gguf");
  try {
    writeFileSync(broken, "not a gguf file");
    writeFileSync(valid, syntheticModel());

    await assert.rejects(
      () => readGgufFactsOffThread(broken),
      /not a GGUF file/,
    );

    const facts = await readGgufFactsOffThread(valid);
    assert.deepEqual(facts.kv, [["general.architecture", "qwen35"]]);
  } finally {
    await stopGgufWorker();
    rmSync(dir, { recursive: true, force: true });
  }
});
