import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveSafetensorsMetadata,
  readSafetensorsFacts,
  readSafetensorsHeader,
  safetensorsDirIdentity,
  safetensorsMissingShardNames,
} from "./safetensors.js";

type TensorSpec = [name: string, dtype: string, shape: number[]];

function safetensorsBuffer(
  tensors: TensorSpec[],
  metadata?: Record<string, string>,
) {
  const header: Record<string, unknown> = metadata
    ? { __metadata__: metadata }
    : {};
  for (const [name, dtype, shape] of tensors) {
    header[name] = { dtype, shape, data_offsets: [0, 0] };
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length), 0);
  return Buffer.concat([length, json]);
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), "arriero-safetensors-"));
}

test("readSafetensorsHeader sums tensor elements per dtype", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "model.safetensors");
    writeFileSync(
      path,
      safetensorsBuffer(
        [
          ["a", "BF16", [4, 4]],
          ["b", "BF16", [4]],
          ["c", "F32", []],
        ],
        { format: "pt" },
      ),
    );

    const summary = readSafetensorsHeader(path);
    assert.equal(summary.tensorCount, 3);
    assert.equal(summary.parameterCount, 21);
    assert.equal(summary.elementsByDtype.get("BF16"), 20);
    assert.equal(summary.elementsByDtype.get("F32"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSafetensorsHeader rejects a truncated file", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "model.safetensors");
    writeFileSync(path, Buffer.from([1, 2, 3]));
    assert.throws(() => readSafetensorsHeader(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config.json model dir derives full metadata", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model.safetensors"),
      safetensorsBuffer([
        ["model.embed_tokens.weight", "BF16", [8, 4]],
        ["model.layers.0.mlp.up_proj.weight", "BF16", [4, 4]],
      ]),
    );
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        architectures: ["Qwen3ForCausalLM"],
        model_type: "qwen3",
        torch_dtype: "bfloat16",
        hidden_size: 4,
        num_hidden_layers: 2,
        num_attention_heads: 4,
        num_key_value_heads: 2,
        head_dim: 64,
        intermediate_size: 16,
        max_position_embeddings: 32768,
        vocab_size: 8,
        sliding_window: 4096,
        tie_word_embeddings: true,
        rope_theta: 1000000,
        rope_scaling: { rope_type: "yarn", factor: 4 },
        transformers_version: "4.55.0",
      }),
    );
    writeFileSync(
      join(dir, "generation_config.json"),
      JSON.stringify({ temperature: 0.7, top_p: 0.8, top_k: 20 }),
    );
    writeFileSync(
      join(dir, "tokenizer_config.json"),
      JSON.stringify({ chat_template: "{{ messages }}" }),
    );

    const { facts, errors } = readSafetensorsFacts(dir);
    assert.deepEqual(errors, []);
    assert.deepEqual(facts.weightFiles, ["model.safetensors"]);

    const metadata = deriveSafetensorsMetadata(facts);
    assert.equal(metadata.kind, "model");
    assert.equal(metadata.architecture, "Qwen3ForCausalLM");
    assert.equal(metadata.modelType, "qwen3");
    assert.equal(metadata.torchDtype, "bfloat16");
    assert.equal(metadata.dominantDtype, "BF16");
    assert.equal(metadata.quantization, "BF16");
    assert.equal(metadata.parameterCount, 48);
    assert.equal(metadata.tensorCount, 2);
    assert.equal(metadata.contextLength, 32768);
    assert.equal(metadata.embeddingLength, 4);
    assert.equal(metadata.blockCount, 2);
    assert.equal(metadata.headCount, 4);
    assert.equal(metadata.headCountKv, 2);
    assert.equal(metadata.headDim, 64);
    assert.equal(metadata.feedForwardLength, 16);
    assert.equal(metadata.slidingWindow, 4096);
    assert.equal(metadata.vocabularySize, 8);
    assert.equal(metadata.tieWordEmbeddings, true);
    assert.equal(metadata.ropeFreqBase, 1000000);
    assert.equal(metadata.ropeScalingType, "yarn");
    assert.equal(metadata.ropeScalingFactor, 4);
    assert.equal(metadata.hasChatTemplate, true);
    assert.equal(metadata.samplingTemp, 0.7);
    assert.equal(metadata.samplingTopK, 20);
    assert.equal(metadata.samplingTopP, 0.8);
    assert.equal(metadata.transformersVersion, "4.55.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an index with an absent shard nulls the parameter count and reports it missing", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model-00001-of-00002.safetensors"),
      safetensorsBuffer([["a", "F16", [4]]]),
    );
    writeFileSync(
      join(dir, "model.safetensors.index.json"),
      JSON.stringify({
        metadata: { total_size: 128 },
        weight_map: {
          a: "model-00001-of-00002.safetensors",
          b: "model-00002-of-00002.safetensors",
        },
      }),
    );

    const { facts } = readSafetensorsFacts(dir);
    assert.deepEqual(facts.weightFiles, ["model-00001-of-00002.safetensors"]);
    assert.deepEqual(safetensorsMissingShardNames(facts), [
      "model-00002-of-00002.safetensors",
    ]);
    assert.equal(facts.indexTotalSizeBytes, 128);

    const metadata = deriveSafetensorsMetadata(facts);
    assert.equal(metadata.parameterCount, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an index keeps consolidated duplicate weights out of the parameter count", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model.safetensors"),
      safetensorsBuffer([["a", "BF16", [4]]]),
    );
    writeFileSync(
      join(dir, "consolidated.safetensors"),
      safetensorsBuffer([["a", "BF16", [4]]]),
    );
    writeFileSync(
      join(dir, "model.safetensors.index.json"),
      JSON.stringify({ weight_map: { a: "model.safetensors" } }),
    );

    const { facts } = readSafetensorsFacts(dir);
    assert.deepEqual(facts.weightFiles, ["model.safetensors"]);
    assert.equal(deriveSafetensorsMetadata(facts).parameterCount, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quantization_config produces the quantization label and method", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model.safetensors"),
      safetensorsBuffer([["a", "I32", [4]]]),
    );
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        model_type: "llama",
        quantization_config: { quant_method: "awq", w_bit: 4 },
      }),
    );

    const metadata = deriveSafetensorsMetadata(readSafetensorsFacts(dir).facts);
    assert.equal(metadata.quantization, "awq 4-bit");
    assert.equal(metadata.quantizationMethod, "awq");
    assert.equal(metadata.dominantDtype, "I32");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an adapter_config.json dir is an adapter with its base model", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "adapter_model.safetensors"),
      safetensorsBuffer([["lora.a", "F32", [2, 2]]]),
    );
    writeFileSync(
      join(dir, "adapter_config.json"),
      JSON.stringify({ base_model_name_or_path: "Qwen/Qwen3-8B" }),
    );

    const metadata = deriveSafetensorsMetadata(readSafetensorsFacts(dir).facts);
    assert.equal(metadata.kind, "adapter");
    assert.equal(metadata.baseModel, "Qwen/Qwen3-8B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare weights dir has kind weights", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "weights.safetensors"),
      safetensorsBuffer([["a", "F16", [2]]]),
    );
    const metadata = deriveSafetensorsMetadata(readSafetensorsFacts(dir).facts);
    assert.equal(metadata.kind, "weights");
    assert.equal(metadata.parameterCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized config values are dropped from the capture", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model.safetensors"),
      safetensorsBuffer([["a", "F16", [2]]]),
    );
    const id2label: Record<string, string> = {};
    for (let index = 0; index < 2000; index += 1) {
      id2label[String(index)] = `label-${index}-padding-padding-padding`;
    }
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ model_type: "vit", id2label }),
    );

    const { facts } = readSafetensorsFacts(dir);
    assert.equal(facts.config?.model_type, "vit");
    assert.equal("id2label" in (facts.config ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat_template.jinja wins over tokenizer_config and text_config nests hparams", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model.safetensors"),
      safetensorsBuffer([["a", "BF16", [2]]]),
    );
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        model_type: "gemma3",
        text_config: {
          hidden_size: 640,
          num_hidden_layers: 18,
          max_position_embeddings: 32768,
        },
      }),
    );
    writeFileSync(
      join(dir, "tokenizer_config.json"),
      JSON.stringify({ chat_template: "from-tokenizer" }),
    );
    writeFileSync(join(dir, "chat_template.jinja"), "from-jinja");

    const { facts } = readSafetensorsFacts(dir);
    assert.equal(facts.chatTemplate, "from-jinja");

    const metadata = deriveSafetensorsMetadata(facts);
    assert.equal(metadata.embeddingLength, 640);
    assert.equal(metadata.blockCount, 18);
    assert.equal(metadata.contextLength, 32768);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed config.json is reported but header facts survive", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "model.safetensors"),
      safetensorsBuffer([["a", "F16", [3]]]),
    );
    writeFileSync(join(dir, "config.json"), "{ not json");

    const { facts, errors } = readSafetensorsFacts(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /config\.json/);
    assert.equal(facts.config, null);
    assert.equal(facts.tensors?.parameterCount, 3);
    assert.equal(deriveSafetensorsMetadata(facts).kind, "weights");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safetensorsDirIdentity covers weights and sidecar files", async () => {
  const dir = makeDir();
  try {
    const weight = join(dir, "model.safetensors");
    writeFileSync(weight, safetensorsBuffer([["a", "F16", [2]]]));
    writeFileSync(join(dir, "config.json"), "{}");

    const first = await safetensorsDirIdentity(dir, [weight]);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ a: 1 }));
    const second = await safetensorsDirIdentity(dir, [weight]);
    assert.notEqual(first.sizeBytes, second.sizeBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
