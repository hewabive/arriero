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
  header — tensor names, dtypes, shapes. Tensor data is never read. Parameter count is the sum of
  shape products, aggregated per dtype. If `model.safetensors.index.json` exists, only files in its
  `weight_map` are counted (this keeps Mistral-style `consolidated.safetensors` duplicates out),
  and index files absent on disk become `missingShardNames`; a missing shard nulls
  `parameterCount` instead of reporting a partial number. Note the count is honest only for
  unquantized checkpoints — packed formats (GPTQ/AWQ int32 packing) undercount, which is why the
  quantization label, not the parameter count, is the primary signal for them.
- **`config.json`** (and `text_config` for multimodal wrappers) → architecture, model type,
  hidden/layer/head/expert geometry, context length, RoPE, `torch_dtype`, `quantization_config`
  (method + bits → the quantization label; otherwise the dominant tensor dtype is the label).
- **`generation_config.json`** → recommended sampling.
- **Chat template**: `chat_template.jinja` wins, then `tokenizer_config.json:chat_template`
  (string or named-list form), then `chat_template.json`. The template string feeds the same
  `chat-template-reasoning` extractor used for GGUF.

Capture is bounded: any top-level config value whose JSON exceeds 16 KiB is dropped (classifier
`id2label` maps and the like), and `tokenizer_config.json` is never captured wholesale — only the
chat template survives. A malformed sidecar is reported in the model's `error` and does not kill
the rest of the read.

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
