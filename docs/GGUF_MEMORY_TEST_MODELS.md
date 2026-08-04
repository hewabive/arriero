# GGUF models for memory-estimator testing

This document is a rolling menu of concrete GGUF artifacts for exercising the
Arriero `llama-server` memory estimator. It starts with small upstream fixtures,
then adds real models only where a fixture cannot reproduce the relevant memory
geometry.

It is deliberately **not** a bundle, a minimum download set, or an estimate of
the set's total size. Pick the rows needed for the branch under test. Individual
sizes are retained so a developer can make that choice on a new machine, but
they are discovery hints rather than acceptance criteria.

Reviewed: **2026-08-04** against the Arriero revision containing this document and llama.cpp
`07132750825a4f2d27a547cd9cdde1c6f6001885` (`b10268-2`). Repository revisions,
file sizes and SHA-256 values below came from the Hugging Face model API with
`blobs=true` on that date.

## How to use the menu

There are two independent coverage axes:

1. **Model geometry** selects which tensors and metadata the estimator sees:
   dense attention, MoE, recurrent state, SWA, shared KV, MLA, projector, MTP,
   encoder-only, and split GGUF.
2. **Launch configuration** changes placement and allocations for the same
   model: context, parallel slots, KV type, batch size, CPU/GPU offload, expert
   offload, projector placement, and draft placement.

Do not download a different model for every launch configuration. Use the
smallest applicable model from the tables and vary its arguments. Conversely,
do not treat two similarly sized decoder models as distinct coverage when they
take the same estimator path.

The status labels mean:

- **anchor**: expected to load in the reviewed llama.cpp and to give a useful
  analytical-versus-`llama-fit-params` comparison;
- **gap canary**: expected to expose a documented omission or incorrect
  estimate; making it pass requires an estimator change, not replacing the
  artifact;
- **format canary**: primarily covers a GGML tensor encoding;
- **quarantine**: retained to recognize a known stale/incompatible artifact,
  but must not be counted as passing coverage;
- **candidate**: a concrete option that was found but not downloaded and
  qualified on the reviewed host; re-check it before relying on it.

## Small upstream fixtures

These are the first files to download for routine work. They are either used by
llama.cpp's own tests or published by `ggml-org` specifically as small test
models.

| Coverage | Artifact | Size | Status and use |
| --- | --- | ---: | --- |
| Dense Llama, F16 KV, CPU/full/partial offload | [`ggml-org/tiny-llamas` / `stories15M-q4_0.gguf`](https://huggingface.co/ggml-org/tiny-llamas/blob/99dd1a73db5a37100bd4ae633f4cfce6560e1567/stories15M-q4_0.gguf) | 19.1 MB | **anchor**. Six attention blocks, 32k vocabulary, Q4_0 weights. Best smoke test for weights, ordinary KV, compute, and sharding. Its head width is 48, so quantized KV types whose block size is 32 are invalid in llama.cpp; use TinyGemma or Qwen for Q8_0/Q4_0 KV tests. SHA-256 `6151b1929d7f5aa3385d9ddef3393e55587c0a55de661562322bc51dfda93a04`. |
| MoE expert placement | [`ggml-org/stories15M_MOE` / `stories15M_MOE-F16.gguf`](https://huggingface.co/ggml-org/stories15M_MOE/blob/b6dd737497465570b5f5e962dbc9d9454ed1e0eb/stories15M_MOE-F16.gguf) | 73.5 MB | **anchor**. Six blocks and 18 expert tensors. Exercise full GPU offload, `--cpu-moe`, and finite `--n-cpu-moe`. SHA-256 `1240dfc1957df9f3550dd6c1d9e64b466fc2f452d8bc34bd4e45e1a1e2ca6055`. |
| Ordinary speculative draft | Use the MoE model above as the target and `stories15M-q4_0.gguf` as `--spec-draft-model` | no additional artifact | **anchor**. This exact target/draft family is used by llama.cpp's server speculative tests and has compatible vocabulary. It covers recursive draft weights, KV, compute, `--spec-draft-ngl`, and draft cache types. |
| Periodic SWA, tied output, and tiny multimodal projector | [`ggml-org/tinygemma3-GGUF` / `tinygemma3-Q8_0.gguf`](https://huggingface.co/ggml-org/tinygemma3-GGUF/blob/c287502cd9e278dac8eed805c112cce5d0081e0b/tinygemma3-Q8_0.gguf) plus [`mmproj-tinygemma3.gguf`](https://huggingface.co/ggml-org/tinygemma3-GGUF/blob/c287502cd9e278dac8eed805c112cce5d0081e0b/mmproj-tinygemma3.gguf) | 47.2 MB + 1.0 MB | **anchor**. Eight Gemma 3 blocks with a 4096-token window and one KV width exercise architecture-period SWA rather than width inference. The missing `output.weight` also covers the GPU copy of tied `token_embd.weight`. The projector covers default GPU placement and `--no-mmproj-offload` without a large download. SHA-256 `7566ae7219c93ea2ecc692a931ee122d30c55261d0e2c3347acb8b939d2e9abd` and `93c2ba8c34574dd8f2dfda64931fc20943de2f941bfe03e6e9eca68951b80604`. |
| Common quant generation | [`ggml-org/tiny-llamas` / `stories15M.gguf`](https://huggingface.co/ggml-org/tiny-llamas/blob/99dd1a73db5a37100bd4ae633f4cfce6560e1567/stories15M.gguf) | 98.4 MB | **format source**. F32 source for generating small F16, Q8_0, legacy Q4/Q5, and K-quant files with the current `llama-quantize`; this avoids relying on many independently maintained repos. SHA-256 `61b50d457809a5194818fd22e6724b456cd7bb9a6264c52c8110684c53f3704a`. |

### Derive a split-GGUF fixture

Split coverage should be generated from the dense fixture rather than tied to
a multi-gigabyte pre-split model. The reviewed command produces six shards and
Arriero must receive the `00001` path:

```bash
GGUF_TEST_DIR=runtime/models/memory-estimation
LLAMA_BUILD_DIR=runtime/builds/master
mkdir -p "$GGUF_TEST_DIR/split"
cmake --build "$LLAMA_BUILD_DIR" --target llama-gguf-split -j
"$LLAMA_BUILD_DIR/bin/llama-gguf-split" \
  --split-max-tensors 10 \
  "$GGUF_TEST_DIR/stories15M-q4_0.gguf" \
  "$GGUF_TEST_DIR/split/stories15M-q4_0"

pnpm memory:calibrate \
  "$GGUF_TEST_DIR/split/stories15M-q4_0-00001-of-00006.gguf"
```

This exercises shard discovery and the sum of every shard's tensor table. It is
not enough to copy only shard 1: llama.cpp and Arriero both require all siblings.

## Modern geometry anchors

The following files are larger because each covers memory geometry absent from
the small fixtures.

| Coverage | Artifact | Size | Status and use |
| --- | --- | ---: | --- |
| Hybrid attention + recurrent state | [`unsloth/Qwen3.5-0.8B-GGUF` / `Qwen3.5-0.8B-Q4_K_M.gguf`](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/blob/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q4_K_M.gguf) | 532.5 MB | **anchor**. `qwen35`, six attention and 18 recurrent blocks, with all four SSM metadata fields consumed by Arriero. Analytical context matched `llama-fit-params` at all harness configurations. Its tied output is the main one-GPU placement anchor: analytical 497 MiB GPU + 199 MiB host weights versus fit 497 + 198 MiB. SHA-256 `bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517`. |
| Current hybrid recurrent model | [`ibm-granite/granite-4.0-h-micro-GGUF` / `granite-4.0-h-micro-Q2_K.gguf`](https://huggingface.co/ibm-granite/granite-4.0-h-micro-GGUF/blob/dc1dd2585fac18a78001c677d33ef8a7bbb7eb68/granite-4.0-h-micro-Q2_K.gguf) | 1,226.2 MB | **anchor**. `granitehybrid`, four attention and 36 recurrent blocks. It complements Qwen with a current vendor-published recurrent layout; MoE placement remains covered by stories15M MoE. Analytical weights and context matched `llama-fit-params` to the displayed MiB on the reviewed CPU run. SHA-256 `736a5f12be0f67dfdc5ece9b3ff4da6b024bf00bbef52765f29c93166d0b1a42`. |
| Distinct-width SWA, shared KV, multimodal, and MTP | [`ggml-org/gemma-4-E2B-it-GGUF` / `gemma-4-E2B-it-Q4_0.gguf`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/blob/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf), [`mmproj-gemma-4-E2B-it-Q8_0.gguf`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/blob/b4243c156154b6dca9324415f8c7ccc098b4aed1/mmproj-gemma-4-E2B-it-Q8_0.gguf), and [`mtp-gemma-4-E2B-it-Q4_0.gguf`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/blob/b4243c156154b6dca9324415f8c7ccc098b4aed1/mtp-gemma-4-E2B-it-Q4_0.gguf) | 2,841.5 MB + 557.4 MB + 59.2 MB | **anchor**. `gemma4` has a 512-token window, 15 physical KV layers, and 20 shared layers. The `gemma4-assistant` MTP file has no K/V tensors and must reuse the target cache. Analytical context matched `llama-fit-params` to 0-2 MiB in the reviewed matrix. Projector and MTP are analytical-only additions. SHA-256 `8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52`, `9406f99c16d68cda4f1f0552192dcc99021ea1fc6d2fd50b1dc3ccf30d04b292`, and `718d3a44057924d5840c65a0aeedf7929366adeeda92a2006955ccabaf645ef4`. |
| MLA and large MoE | [`bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF` / `DeepSeek-Coder-V2-Lite-Instruct-IQ2_XS.gguf`](https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/blob/8f248fa2072348f77a8bc37754e470de1f61866e/DeepSeek-Coder-V2-Lite-Instruct-IQ2_XS.gguf) | 5,967.4 MB | **anchor**. `deepseek2` with legacy MLA and 78 expert tensors. Metadata-derived K/V geometry matches 1080/4320/2295/1215 MiB context projections for 4k/16k F16/Q8_0/Q4_0. The CUDA cases also cover context-sized host staging under Flash Attention and quantized KV; aggregate compute differs from fit by -3.6% to +5.1%. SHA-256 `13106ce47dee9380b03ff27e88c87076604a01c85fea9fab191f827c234b46d3`. |

For Gemma 4, test both the parts independently and the composite instance:

```text
--model gemma-4-E2B-it-Q4_0.gguf
--mmproj mmproj-gemma-4-E2B-it-Q8_0.gguf
--spec-draft-model mtp-gemma-4-E2B-it-Q4_0.gguf
--spec-type draft-mtp
```

Then repeat once with `--no-mmproj-offload`, once with `--no-kv-offload`, and
once with a draft-specific `--spec-draft-ngl`. `llama-fit-params` does not accept
the projector, so compare its main-model columns separately from Arriero's
composite total.

## Classic, role-specific, and recurrent anchors

These are intentionally not interchangeable with the modern anchors. They
cover tensor naming and runtime allocation rules that a Llama-like decoder does
not reveal.

| Coverage | Artifact | Size | Expected result |
| --- | --- | ---: | --- |
| Classic GPT-2 MHA | [`mradermacher/tiny-random-gpt2-GGUF` / `tiny-random-gpt2.f16.gguf`](https://huggingface.co/mradermacher/tiny-random-gpt2-GGUF/blob/ce6c3b782e51caef90f6bb1e7cae292afea6f878/tiny-random-gpt2.f16.gguf) | 16.0 MB | **anchor**. GPT-2's fused `attn_qkv` projection exercises metadata-derived K/V geometry. Analytical context matches the 4 and 16 MiB fit projections at 4k and 16k. SHA-256 `79fa9fac98ece8d99627f0b28302d2698782b05e0df2de3c0b360f6be79fe0f8`. |
| Embedding/encoder-only BERT | [`ggml-org/e5-small-v2-Q8_0-GGUF` / `e5-small-v2-q8_0.gguf`](https://huggingface.co/ggml-org/e5-small-v2-Q8_0-GGUF/blob/14aa7ca88ca627e2ea0051929636561158e289ab/e5-small-v2-q8_0.gguf) | 36.7 MB | **anchor**. Run as an embedding instance. Arriero recognizes the non-causal architecture, allocates zero persistent KV exactly like fit, and sizes compute from the encoder activation width instead of decoder logits. SHA-256 `afdfb5c342d2efc2a051c426dd1d00913495d5f2bbceaea100d2f3892aa31cbc`. |
| Reranker/classifier role | [`ggml-org/models` / `jina-reranker-v1-tiny-en/ggml-model-f16.gguf`](https://huggingface.co/ggml-org/models/blob/499bc8821c6b12b4e53c5bffcb21ec206f212d81/jina-reranker-v1-tiny-en/ggml-model-f16.gguf) | 67.5 MB | **anchor**. Upstream llama.cpp server fixture with a classifier head; use with `--reranking`. Persistent KV is zero and analytical compute is 12 versus 11 MiB at default ubatch, then exactly 24 MiB at ubatch 1024. SHA-256 `ad9f450c1053a431e2e3746d1f9f7768fb9183cf0796e046983a3449dca093c2`. |
| Pure Mamba SSM | [`QuantFactory/mamba-130m-hf-GGUF` / `mamba-130m-hf.Q2_K.gguf`](https://huggingface.co/QuantFactory/mamba-130m-hf-GGUF/blob/b459c7cf440d850438589a45e8e3b55f33211c42/mamba-130m-hf.Q2_K.gguf) | 69.3 MB | **anchor**. Its metadata lacks `ssm.group_count`, covering llama.cpp's Mamba default of zero groups. The modeled context-independent state is within one displayed MiB of fit. SHA-256 `58ab1786685f602ce4900d6c9a0a1f1abfaebb096f2ef082e60f2cdd9fc6dd42`. |
| Current RWKV-7 recurrent layout and IQ1_S | [`RemySkye/rwkv7-g1h-1.5b-i1-GGUF` / `rwkv7-g1h-1.5b-20260710-ctx10240.i1-IQ1_S.gguf`](https://huggingface.co/RemySkye/rwkv7-g1h-1.5b-i1-GGUF/blob/aece029dca2fda812f7a2a960067a36d2b26e3ed/rwkv7-g1h-1.5b-20260710-ctx10240.i1-IQ1_S.gguf) | 497.2 MB | **anchor + format anchor**. `wkv_head_size` and token-shift metadata model RWKV's context-independent state within one displayed MiB of fit. Also covers IQ1_S weight byte accounting. SHA-256 `1fd2a536e0c8e7d4a0890dc5a33b91352e5e11c7884ec353177a9f516d401e41`. |

## Weight-format canaries

Weight quantization affects resident weights; KV quantization is selected by
launch arguments and is a separate axis. Do not use a weight-quant suffix as a
substitute for `--cache-type-k`/`--cache-type-v` testing.

| Format | Artifact | Size | Status |
| --- | --- | ---: | --- |
| F32/F16, legacy Q4/Q5, Q8_0, K-quants | Generate from `stories15M.gguf` with the reviewed `llama-quantize` | varies | **format anchors**. Generate outputs with the binary being qualified so tensor type IDs stay in sync. The tiny model's 288-wide tensors force expected fallback types for some K-quants, which also gives useful mixed-type coverage. |
| IQ1_S | RWKV-7 file above | 497.2 MB | **format canary**, locally read and accepted by `llama-fit-params`. |
| IQ2_XS | DeepSeek V2 Lite file above | 5,967.4 MB | **format canary**, locally read and accepted by `llama-fit-params`. |
| MXFP4 MoE | [`ggml-org/gpt-oss-20b-GGUF` / `gpt-oss-20b-MXFP4.gguf`](https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/blob/ef9b12f2ff56c69cf32153a02784e7a3c88bf524/gpt-oss-20b-MXFP4.gguf) | 12,109.6 MB | **format + periodic-SWA anchor** for native MXFP4 MoE and the modern `gpt-oss` layout. Arriero reported no unknown tensor types, its weight sum matched `llama-fit-params` to 1 MiB, and the alternating single-width SWA context matched across the reviewed matrix. SHA-256 `27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`. |
| NVFP4 + MTP | [`michaelw9999/Qwen3.6-35B-A3B-NVFP4-MTP-GGUF` / `Qwen3.6-35B-A3B-NVFP4-MTP-TURBO.gguf`](https://huggingface.co/michaelw9999/Qwen3.6-35B-A3B-NVFP4-MTP-GGUF/blob/df112dd576e55b1daa1331a7831b64ec9c03dbae/Qwen3.6-35B-A3B-NVFP4-MTP-TURBO.gguf) | 20,407.4 MB | **candidate**. Covers the new NVFP4 tensor type in a large current model. Not downloaded on the reviewed host; refresh the repo and verify `unknownTypeIds` before use. SHA-256 `f3d2fdc74e3ef19925ccbf794b04d7f6f11fb12eba7722b7749219d0cc5c36ed`. |
| Old BitNet `i2_s` | [`microsoft/BitNet-b1.58-2B-4T-gguf` / `ggml-model-i2_s.gguf`](https://huggingface.co/microsoft/BitNet-b1.58-2B-4T-gguf/blob/a1f2f1c765812aa8af3f6eda4a313707064bba15/ggml-model-i2_s.gguf) | 1,187.8 MB | **quarantine**. On reviewed llama.cpp, tensor type ID 36 is a removed `IQ4_NL_4_4` encoding and the model fails before allocation. Arriero also cannot account for those tensors. Keep this row to prevent accidental reintroduction; replace it only with a BitNet/TQ artifact that both current llama.cpp and Arriero accept. SHA-256 `4221b252fdd5fd25e15847adfeb5ee88886506ba50b8a34548374492884c2162`. |

Build the quantizer on demand; Arriero's normal server build does not publish
this companion automatically:

```bash
GGUF_TEST_DIR=runtime/models/memory-estimation
LLAMA_BUILD_DIR=runtime/builds/master
cmake --build "$LLAMA_BUILD_DIR" --target llama-quantize -j
"$LLAMA_BUILD_DIR/bin/llama-quantize" \
  "$GGUF_TEST_DIR/stories15M.gguf" \
  "$GGUF_TEST_DIR/stories15M-Q4_K_M.generated.gguf" \
  Q4_K_M
```

Before accepting a new format canary, require all three conditions:

1. `readGgufModelTensorTable` returns `unknownTypeIds: []`;
2. the tensor-byte sum is close to the file's payload size, allowing only GGUF
   metadata and alignment overhead;
3. the pinned `llama-fit-params` loads it successfully.

## Launch-argument matrix

Use the following rows as independent test cases. The suggested model is the
smallest one that exercises the relevant branch reliably.

| Branch | Arguments to compare | Suggested artifact | Expected invariant |
| --- | --- | --- | --- |
| Context growth | `--ctx-size 4096`, `16384`, and a value above training context where llama.cpp permits it | `stories15M-q4_0`; Qwen3.5; Gemma 4 | Ordinary KV grows with context; modeled recurrent state does not. |
| Parallel slots | `--parallel 1` vs `4`, with `--kv-unified` on and off | Qwen3.5 and Gemma 4 | Recurrent state and SWA stream state scale with sequence count; unified global KV does not. |
| KV encodings | F16, Q8_0, and Q4_0 for both `--cache-type-k` and `--cache-type-v` | TinyGemma or Qwen3.5 | KV bytes follow GGML row size. Do not use stories15M for quantized KV because its 48-wide heads are incompatible with 32-element blocks in llama.cpp. |
| Compute | `--ubatch-size 128`, `512`, `1024`; vary `--batch-size` separately | Any model; Gemma 4 stresses the large vocabulary | Dominant compute reservation is linear in `n_vocab * n_ubatch`, not context or parallel slots. |
| CPU, partial, full GPU | `--n-gpu-layers 0`, a finite middle value, and `all`/`999` | `stories15M-q4_0` first, then Qwen3.5 or TinyGemma | Tensor weights move by layer; input embedding remains on host and compute follows the output layer. If `output.weight` is absent, the tied token embedding also appears on the output GPU. Omitted/`auto` GPU layers use a conservative full-offload estimate. |
| KV placement | full GPU offload with and without `--no-kv-offload` | TinyGemma or Qwen3.5 | KV moves to host while weights and compute remain placed by layer. |
| MoE expert placement | full GPU offload; add `--cpu-moe`; then finite `--n-cpu-moe` | `stories15M_MOE-F16` | Only expert tensors in the selected layers move back to host. |
| Multiple GPUs | two or more GPU pools; compare equal and unequal `--tensor-split` | Any dense anchor; repeat with MoE | Layer weights and KV follow the split; compute follows the output layer. Requires a multi-GPU host or a pure analytical pool fixture. |
| Flash attention | `--flash-attn off` vs `on`, including quantized KV | TinyGemma/Qwen3.5 for ordinary attention; DeepSeek for MLA | Ordinary-attention analytical compute stays stable. GPU MLA adds context-sized host staging for Flash Attention or quantized K cache. Compare to the matching binary. |
| Projector | `--mmproj`, then add `--no-mmproj-offload` | TinyGemma pair for smoke, Gemma 4 pair for real size | Projector weights move GPU -> host; image-time compute remains a documented omission. |
| Draft model | target only vs `--spec-draft-model`; vary `--spec-draft-ngl` and draft cache types | stories15M MoE + stories15M draft | Draft weights, compute and its own KV are added recursively. |
| MTP | add the `gemma4-assistant` file with `--spec-type draft-mtp` | Gemma 4 trio | MTP weights/compute are added, but the head has no independent KV. |
| Split files | monolith vs generated `00001-of-00006` path | `stories15M-q4_0` | Analytical tensor sum and fit projection match the monolith. |

Hardware coverage is separate from model coverage. At minimum, retain results
from a CPU-only host, a one-GPU host, and a two-or-more-GPU host. Add a NUMA host
only when validating measured RSS or placement; NUMA policy does not currently
change the analytical byte total.

## Download and verification workflow

Arriero's estimator currently requires local `--model`, `--mmproj`, and draft
paths; `--hf-repo` and `--model-url` are rejected by the estimation endpoint.
Download only the chosen rows. A reproducible pinned download looks like:

```bash
GGUF_TEST_DIR=runtime/models/memory-estimation
mkdir -p "$GGUF_TEST_DIR"

curl -fL --continue-at - \
  'https://huggingface.co/ggml-org/tiny-llamas/resolve/99dd1a73db5a37100bd4ae633f4cfce6560e1567/stories15M-q4_0.gguf' \
  -o "$GGUF_TEST_DIR/stories15M-q4_0.gguf"

printf '%s  %s\n' \
  '6151b1929d7f5aa3385d9ddef3393e55587c0a55de661562322bc51dfda93a04' \
  "$GGUF_TEST_DIR/stories15M-q4_0.gguf" | sha256sum -c -
```

For exploratory work, replace the revision with `main` and query the model API
before downloading. Once a result matters, record the resolved revision and
SHA-256. Do not silently update a pin and compare the result to an older
calibration.

Build Arriero and run the analytical/llama.cpp comparison with the binary being
qualified:

```bash
pnpm build
pnpm memory:calibrate \
  --fit-params runtime/builds/master/bin/llama-fit-params \
  --out tmp/memory-calibration-cpu.json \
  runtime/models/memory-estimation/stories15M-q4_0.gguf

pnpm memory:calibrate \
  --fit-params runtime/builds/master/bin/llama-fit-params \
  --gpus 1 \
  --out tmp/memory-calibration-gpu.json \
  runtime/models/memory-estimation/stories15M-q4_0.gguf
```

`--gpus` changes the analytical pool matrix and supplies GPU-offload cases to
the harness; the companion binary must itself be built with the backend being
qualified. A CPU-only `llama-fit-params` cannot validate CUDA placement.

## Qualification snapshot and known outcomes

Every non-candidate row was downloaded and SHA-256 checked on a Linux x86-64
host with 31 GiB RAM and one RTX A5000 (24 GiB). The CPU and one-GPU matrices
used the current `scripts/memory-estimate-calibrate.mjs` cases and CPU/CUDA
builds from the same llama.cpp commit. “Exact context” below means equal at
displayed MiB, or within rounding; it does not make the same claim for weights,
compute, or analytical per-pool placement.

| Artifact | Reviewed outcome |
| --- | --- |
| stories15M dense and MoE | Loaded; ordinary F16 KV matched exactly. The CUDA server completed a real draft-simple request with accepted draft tokens. Quantized KV correctly failed in llama.cpp because head width 48 is incompatible with the cache block size. |
| TinyGemma 3 | Loaded with its projector in the CUDA server and passed `/health`; periodic single-width SWA context matched, and GPU tied-output weights were 73 versus 72 MiB after displayed rounding. |
| Qwen3.5 0.8B | Loaded; modeled recurrent + attention context matched across context sizes, KV types, and ubatch cases. One-GPU weights split analytically as 497 MiB GPU + 199 MiB host versus fit 497 + 198 MiB; compute stayed within +0.4–0.8%. |
| Granite 4.0 H Micro | Loaded; weights matched displayed MiB and modeled recurrent + attention context matched exactly. |
| Gemma 4 E2B | Loaded as the full model + projector + MTP trio in the CUDA server; logs confirmed MTP cache sharing and a real completion accepted draft tokens. Distinct-width SWA/shared-KV context matched within 0-2 MiB, tied-output GPU weights matched within 1 MiB, and projector/MTP bytes were included by the analytical composite path. |
| DeepSeek V2 Lite | Loaded; legacy MLA context matched exactly at displayed MiB for every F16/Q8_0/Q4_0 case. GPU host staging closed the large quantized-KV/Flash-Attention compute omission; aggregate compute is within -3.6% to +5.1%. |
| tiny GPT-2 | Loaded; fused-QKV context matched exactly at displayed MiB. |
| e5-small-v2 | Loaded; non-causal classification now produces zero persistent KV exactly; compute is within 1 MiB at default ubatch and exact at ubatch 1024. |
| Jina tiny reranker | Loaded; classifier detection now produces zero persistent KV exactly and compute 12 versus 11 MiB at default ubatch, then 24 MiB exactly at ubatch 1024. |
| Mamba 130M and RWKV-7 | Loaded; recurrent-state projections are within one displayed MiB of fit for both architectures. |
| GPT-OSS 20B MXFP4 | Loaded on CPU and CUDA builds with no unknown tensor types; analytical weights matched `llama-fit-params` to 1 MiB and alternating single-width SWA context matched across the matrix. |
| old Microsoft BitNet `i2_s` | Arriero read the header but could not account for all tensor types; current llama.cpp rejected the removed encoding. Quarantined. |

The CUDA matrix reproduced the same context results for the dense, MoE, Qwen,
Granite, Gemma, DeepSeek, and GPT-OSS rows. A per-device comparison closed the
one-GPU tied-output rule and calibrated MLA host staging. Multi-GPU splits,
non-CUDA backends, and the fixed per-GPU context margin remain source-derived
conservative approximations rather than hardware-qualified invariants.

Raw calibration JSON belongs in `tmp/` or an explicitly dated qualification
record, not in this rolling menu.

## Maintenance checklist

When llama.cpp gains an architecture, cache implementation, or tensor type:

1. Compare it with the estimator's actual branches in
   `packages/core/src/memory-estimate.ts`; add a model only if it contributes a
   new branch or guards a known gap.
2. Prefer `ggml-org` test fixtures, then a model-vendor GGUF, then a reputable
   third-party quant when no upstream artifact exists.
3. Query `https://huggingface.co/api/models/<repo>?blobs=true`; confirm the
   filename, revision, size, and SHA-256 still exist.
4. Download and require `unknownTypeIds: []` before running accuracy
   comparisons. A parsed GGUF header alone is not enough.
5. Run `pnpm memory:calibrate` with the same llama.cpp revision as the server
   binary, plus the composite API path for projector and draft cases.
6. Update the reviewed date and qualification outcome. Preserve an old row as
   **quarantine** when it is useful for recognizing a compatibility break;
   otherwise replace stale links rather than accumulating near-duplicates.
7. Keep individual sizes, but do not add or maintain a total-size claim. The
   menu is meant to remain modular as model families change.
