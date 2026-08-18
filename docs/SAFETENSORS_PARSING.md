# Safetensors model scanning and the safetensors cache

Alongside GGUF files, the model scan treats every directory that holds at least one
`*.safetensors` file as one model entity — the classic Hugging Face repository layout that vLLM and
KTransformers consume. This document is the contract for how those directories are discovered,
parsed and cached; the GGUF counterpart (worker isolation, the two-layer cache idea) is
`docs/GGUF_PARSING.md` and applies here unchanged unless stated otherwise.

## The directory is the model

Identity is the directory path, not a file path. `models/scanner.ts` groups every `*.safetensors`
file found during the walk by its containing directory; one directory produces one
`SafetensorsModel` whose `path` is the directory. Change detection
(`safetensorsDirIdentity`) sums sizes and takes the newest mtime across all weight files **plus**
the sidecar files (`config.json`, `adapter_config.json`, `generation_config.json`,
`tokenizer_config.json`, `chat_template.jinja`, `chat_template.json`,
`model.safetensors.index.json`) — editing a config invalidates the cache entry even though no
weight changed.

The directory kind is derived, not guessed from names:

- `config.json` present → `model` (a transformers checkpoint),
- else `adapter_config.json` present → `adapter` (LoRA/PEFT; `baseModel` is captured),
- else → `weights` (bare tensors; header facts only).

## What is read

`models/safetensors.ts:readSafetensorsFacts(dir)` runs sync inside the shared parse worker
(`gguf-worker.ts`, op `safetensors-facts`) and never on a request path:

- **Weight headers.** Each safetensors file contributes only its 8-byte length prefix plus the JSON
  header — tensor names, dtypes, shapes. Raw facts aggregate element counts per
  (tensor-name suffix, dtype) group — the suffix is the last dot segment, with anything under
  `.quant_state.` collapsed to one `quant_state` group — and per leading-prefix group (the first
  name segment, stepping over a bare `model.` wrapper). Prefix groups power component detection in
  derive: a vision tower (`visual`/`vision_tower`/… → `visionParameterCount`) and a NextN/MTP head
  (`mtp` → `mtpParameterCount`) report their stored elements, or null when absent — tensor
  presence, not config, is the signal, because quantized re-uploads routinely keep the base
  model's config while dropping those tensors. Component counts are raw stored elements (no
  packed-weight expansion; these blocks are practically never packed). The single exception to "tensor data is
  never read": `weight_shape` sidecar tensors (compressed-tensors `pack-quantized`) are tiny I64
  shape records whose contents are read and summed into `packedShape`, because they are the exact
  unpacked size of the packed weights. If `model.safetensors.index.json` exists, only files in its
  `weight_map` are counted (this keeps Mistral-style `consolidated.safetensors` duplicates out),
  and index files absent on disk become `missingShardNames`; a missing shard nulls
  `parameterCount` instead of reporting a partial number.
- **`config.json`** (and `text_config` for multimodal wrappers) → architecture, model type,
  hidden/layer/head/expert geometry, context length, RoPE, `torch_dtype`, `quantization_config`
  (method + bits, dug out of compressed-tensors `config_groups` when not top-level → the
  quantization label; otherwise the dominant tensor dtype is the label).
- **`generation_config.json`** → recommended sampling.
- **Chat template**: `chat_template.jinja` wins, then `tokenizer_config.json:chat_template`
  (string or named-list form), then `chat_template.json`. The template string feeds the same
  `chat-template-reasoning` extractor used for GGUF.

Capture is bounded: any top-level config value whose JSON exceeds 16 KiB is dropped (classifier
`id2label` maps and the like), and `tokenizer_config.json` is never captured wholesale — only the
chat template survives. `quantization_config` gets one retry before dropping: its bulk module
lists (`ignore`, `modules_to_not_convert`, `llm_int8_skip_modules`) are stripped and the trimmed
object is captured if it now fits — losing the scheme would break parameter recovery and the
quantization label. A malformed sidecar is reported in the model's `error` and does not kill the
rest of the read.

## Parameter counting for quantized checkpoints

A raw element sum lies for packed formats — an AWQ int4 checkpoint packs 8 weights per stored I32
element, so a 0.75B model reads as ~0.3B. `deriveTensorStats` (derive layer, so format additions
are usually a parser-version bump) recovers the true count once a directory is recognized as
quantized (`quantization_config` present, or `weight_packed`/`qweight` suffix groups exist):

- **Quantization overhead is excluded**: `scales`/`qzeros`/`zeros`/`g_idx`,
  `weight_scale`/`weight_zero_point`/`weight_shape`/`weight_g_idx`/`weight_scale_inv`, fp8
  activation/kv scales (`input_scale`, `k_scale`, …), bitsandbytes state (`absmax`, `quant_map`,
  nested variants, `SCB`, `quant_state`). Unquantized directories keep the plain per-dtype sum, so
  an innocent tensor whose name ends in `scales` is unaffected there.
- **compressed-tensors `pack-quantized`**: `weight_packed` expands via the summed `weight_shape`
  contents when every packed tensor has a readable shape record (exact, covers nvfp4 U8 packing
  too); otherwise by `containerBits / num_bits`.
- **AWQ/GPTQ GEMM**: `qweight` expands by `32 / bits` from the config; with no bits declared the
  pack factor is inferred from the `scales`-to-`qzeros` element ratio (both layouts store one
  unpacked scale row and one packed zero row per group).
- **bitsandbytes 4-bit**: U8 `weight` tensors double (two nf4/fp4 nibbles per byte); **mxfp4**
  (gpt-oss): `*blocks` U8 tensors double, `*scales` are overhead.
- A packed group whose factor cannot be determined leaves `parameterCount` **null** rather than
  reporting a plausible-but-wrong number; `elementsByDtype` then falls back to storage elements
  for that group.

`elementsByDtype` (and thus `dominantDtype`) reports recovered parameters with packed groups
relabeled to the logical type (`int4`, `fp4`, `nf4`), so the dtype split sums to the parameter
count. compressed-tensors `int-quantized`/`float-quantized` weights are stored 1:1 (I8/F8) and
need no expansion; `dense` fake-quant stays full-precision with only scale remnants excluded.

## Two-layer cache

`safetensors_cache` mirrors `model_cache` exactly: `raw_json`/`SAFETENSORS_RAW_VERSION` hold the
captured facts, `metadata_json`/`SAFETENSORS_PARSER_VERSION` the derived
`SafetensorsMetadata`; `deriveSafetensorsMetadata(facts)` rebuilds the derived layer from raw facts
with no disk access when only the parser version moves. The same rule applies when adding a field:
derived-only change → bump `SAFETENSORS_PARSER_VERSION`; new capture → bump
`SAFETENSORS_RAW_VERSION` too. Pruning removes rows whose directory disappeared **or no longer
contains any `*.safetensors` file** (deleting weights while keeping configs must drop the entry).

## Surfaces

- `GET /api/models` returns them as `ModelScanResult.safetensors`; scan progress and cache
  hit/miss counters cover both formats.
- The web Models page renders a separate "Safetensors models" section (hidden while empty) with
  the same search box; "Use in new" seeds a vLLM instance with the directory as the positional
  model argument. The vLLM/KTransformers model inputs autocomplete from scanned safetensors
  directories.
- A finished HF download of a `.safetensors` file triggers the same refresh rescan as a GGUF one.
- Memory estimation stays GGUF-only: the llama estimator rejects a directory `--model` with an
  explicit reason instead of failing deep with `EISDIR`.
