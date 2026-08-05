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
`07132750825a4f2d27a547cd9cdde1c6f6001885` (`b10270`). Repository revisions,
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
| Short-convolution hybrid state | [`LiquidAI/LFM2-350M-GGUF` / `LFM2-350M-Q4_0.gguf`](https://huggingface.co/LiquidAI/LFM2-350M-GGUF/blob/8fdc9d526b7ed346b19257551b05816c7912ecc2/LFM2-350M-Q4_0.gguf) | 219.3 MB | **anchor**. `lfm2` has six attention and ten recurrent short-convolution layers. Arriero reads `shortconv.l_cache` and applies `n_embd * (l_cache - 1)` F32 state elements per recurrent layer and sequence. Context matched fit exactly at displayed MiB across 4k/16k, all cache cases, and CUDA offload; compute was +4.3–5.8%. A real CUDA server request completed. SHA-256 `8e3ebc1c608dc8683adf8c3b3e6a40e2f4eab22aa33b908bff2ac03a1c16d796`. |
| Attention and SSM in the same layer | [`tiiuae/Falcon-H1-0.5B-Instruct-GGUF` / `Falcon-H1-0.5B-Instruct-Q4_0.gguf`](https://huggingface.co/tiiuae/Falcon-H1-0.5B-Instruct-GGUF/blob/9bf0c2d4391cf4850aa62bfee1d8fe71afba8be2/Falcon-H1-0.5B-Instruct-Q4_0.gguf) | 308.1 MB | **anchor**. All 36 `falcon-h1` blocks allocate both ordinary attention KV and SSM state; this must not be treated as the disjoint Qwen/Granite pattern. Analytical weights matched fit, context stayed within one displayed MiB, and compute was within -1.4% to -5.3%. A real CUDA server request completed. SHA-256 `66fe30f9adf8b20851233d30bdb22bc06b334ff347df47a38d52760ee84d1cd5`. |
| Audio projector and full KV-type matrix | [`ggml-org/Qwen3-ASR-0.6B-GGUF` / `Qwen3-ASR-0.6B-Q8_0.gguf`](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/blob/928ab958557df9aa2ef1c93e0e83c7ad0933fae2/Qwen3-ASR-0.6B-Q8_0.gguf) plus [`mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/blob/928ab958557df9aa2ef1c93e0e83c7ad0933fae2/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf) | 804.7 MB + 214.4 MB | **anchor**. Small official audio pair. A real MP3 transcription completed on CUDA. Main-model weights differed from fit by +0.1%, KV matched exactly, and compute stayed within 2%. The same model accepted every current cache type (`f32`, `f16`, `bf16`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, `q5_1`) with exact analytical KV MiB. SHA-256 `bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971` and `41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d`. |
| Cacheless diffusion decoder with vocabulary logits | [`mradermacher/LLaDA-1.5-GGUF` / `LLaDA-1.5.Q2_K.gguf`](https://huggingface.co/mradermacher/LLaDA-1.5-GGUF/blob/57e245e7c698428c699687dc55b2392ec35c4059/LLaDA-1.5.Q2_K.gguf) | 3,163.8 MB | **llama.cpp library/fit anchor; llama-server quarantine**. `llada` is non-causal and has zero persistent KV, but unlike an embedding encoder it retains vocabulary logits. Analytical weights and KV matched fit at 3,012 and 0 MiB; compute matched 271 MiB at the default ubatch and was 542 versus 544 MiB at ubatch 1024. A real CUDA `llama-diffusion-cli` generation completed. The reviewed `llama-server` b10270 instead hit an `n_outputs_max` assertion during warmup, so this is not an Arriero server end-to-end qualification. SHA-256 `36abde895a53cf9a6a9fda33ce30891ab070b55d08b2a46bc8d69ed1083c9a23`. |
| Current hybrid recurrent model | [`ibm-granite/granite-4.0-h-micro-GGUF` / `granite-4.0-h-micro-Q2_K.gguf`](https://huggingface.co/ibm-granite/granite-4.0-h-micro-GGUF/blob/dc1dd2585fac18a78001c677d33ef8a7bbb7eb68/granite-4.0-h-micro-Q2_K.gguf) | 1,226.2 MB | **anchor**. `granitehybrid`, four attention and 36 recurrent blocks. It complements Qwen with a current vendor-published recurrent layout; MoE placement remains covered by stories15M MoE. Analytical weights and context matched `llama-fit-params` to the displayed MiB on the reviewed CPU run. SHA-256 `736a5f12be0f67dfdc5ece9b3ff4da6b024bf00bbef52765f29c93166d0b1a42`. |
| Distinct-width SWA, shared KV, multimodal, and shared-KV assistant | [`ggml-org/gemma-4-E2B-it-GGUF` / `gemma-4-E2B-it-Q4_0.gguf`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/blob/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf), [`mmproj-gemma-4-E2B-it-Q8_0.gguf`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/blob/b4243c156154b6dca9324415f8c7ccc098b4aed1/mmproj-gemma-4-E2B-it-Q8_0.gguf), and [`mtp-gemma-4-E2B-it-Q4_0.gguf`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/blob/b4243c156154b6dca9324415f8c7ccc098b4aed1/mtp-gemma-4-E2B-it-Q4_0.gguf) | 2,841.5 MB + 557.4 MB + 59.2 MB | **anchor**. `gemma4` has a 512-token window, 15 physical KV layers, and 20 shared layers. The four-layer `gemma4-assistant` must reuse target global/SWA KV rather than allocate its own. The current server reached listening and logged all four mappings; its assistant footprint is therefore weights + compute, not an ordinary second KV. SHA-256 `8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52`, `9406f99c16d68cda4f1f0552192dcc99021ea1fc6d2fd50b1dc3ccf30d04b292`, and `718d3a44057924d5840c65a0aeedf7929366adeeda92a2006955ccabaf645ef4`. |
| Embedded/self MTP | [`nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP` / `Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf`](https://huggingface.co/nerkyor/Qwen3.5-9B-GGUF-imatrix-MTP/blob/210257318cc63d429525efa6f35a0bd17dd3c295/Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf) | 5,780.1 MB | **anchor**. Third-party but pinned and host-qualified. `block_count=33`, `nextn_predict_layers=1`; `--spec-type draft-mtp` creates a second context over the same weight buffers. A real CUDA request accepted 17/17 draft tokens. Arriero projected 6,168 MiB device buffers (6,568 MiB with margin); NVML observed 5,740 MiB. SHA-256 `0f292ba0d1058065a6624883a76a2adf00b266d07b9396ed67b155ff522e18d4`. |
| MLA and large MoE | [`bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF` / `DeepSeek-Coder-V2-Lite-Instruct-IQ2_XS.gguf`](https://huggingface.co/bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF/blob/8f248fa2072348f77a8bc37754e470de1f61866e/DeepSeek-Coder-V2-Lite-Instruct-IQ2_XS.gguf) | 5,967.4 MB | **anchor**. `deepseek2` with legacy MLA and 78 expert tensors. Metadata-derived K/V geometry matches 1080/4320/2295/1215 MiB context projections for 4k/16k F16/Q8_0/Q4_0. The CUDA cases also cover context-sized host staging under Flash Attention and quantized KV; aggregate compute differs from fit by -3.6% to +5.1%. SHA-256 `13106ce47dee9380b03ff27e88c87076604a01c85fea9fab191f827c234b46d3`. |
| KDA recurrent state + compressed MLA + large MoE | [`ymcki/Kimi-Linear-48B-A3B-Instruct-GGUF` / `Kimi-Linear-48B-A3B-Instruct-jp-imatrix.Q2_K.gguf`](https://huggingface.co/ymcki/Kimi-Linear-48B-A3B-Instruct-GGUF/blob/3ac12d33f0597baa53c3a1c8f2aec3bbc434d6b4/Kimi-Linear-48B-A3B-Instruct-jp-imatrix.Q2_K.gguf) | 18,028.5 MB | **anchor, expensive but host-qualified**. `kimi-linear` has seven compressed-MLA layers and 20 KDA recurrent layers. KDA projection tensors use attention-like names but allocate convolution + matrix state rather than token KV; Arriero separates them and reads `kda.head_dim`. Analytical weights were 17,187 versus 17,186 MiB, context was exact or within one MiB across the matrix, and compute was +1.7–3.5%. A real CUDA server request completed at 17,494 MiB NVML before the request and 17,500 MiB after it. SHA-256 `10b5027612eb1ad2a21bffdf4b99397d59630e91aac95e7be6244651a2cee571`. |
| Separate NextN/MTP sidecar | [`ggml-org/Qwen3.6-27B-GGUF` / `Qwen3.6-27B-Q4_K_M.gguf`](https://huggingface.co/ggml-org/Qwen3.6-27B-GGUF/blob/8a7ee08e8b9bfb857107ecc25a5599d2f38b76f8/Qwen3.6-27B-Q4_K_M.gguf) plus [`mtp-Qwen3.6-27B-Q4_0.gguf`](https://huggingface.co/ggml-org/Qwen3.6-27B-GGUF/blob/8a7ee08e8b9bfb857107ecc25a5599d2f38b76f8/mtp-Qwen3.6-27B-Q4_0.gguf) | 19,095.8 MB + 1,680.3 MB | **anchor**, expensive but official. The target has 64 trunk layers; the sidecar declares `block_count=65`, `nextn_predict_layers=1`, 18 tensors, and a real independent KV. A CUDA request accepted 17/17 draft tokens. Arriero projected 19,888 MiB device buffers (20,288 MiB with margin) versus 19,814 MiB observed by NVML. SHA-256 `65b753ea835627f7b511143c6ceb976525c7f21f5df8c664bc0a9c23d1c49921` and `3d593f9e2788d59bb30d6024706b1efd5219fea466b6397c46159e3540937173`. |
| DFlash sidecar | Reuse the Qwen3.6 target above with [`ggml-org/Qwen3.6-27B-GGUF` / `dflash-Qwen3.6-27B-Q8_0.gguf`](https://huggingface.co/ggml-org/Qwen3.6-27B-GGUF/blob/8a7ee08e8b9bfb857107ecc25a5599d2f38b76f8/dflash-Qwen3.6-27B-Q8_0.gguf) | +1,849.5 MB | **anchor**. Five-stage `dflash` draft with four 2048-token SWA layers and one global layer. At ctx 4096 / parallel 1 the current CUDA server allocated 1,753.36 MiB weights, 56 MiB KV, and 511.52 MiB compute; Arriero projected 1,753, 56, and 553 MiB. A real request accepted 17/17 draft tokens. SHA-256 `a31adddb37adaca315b94a18d96d124135ee15b76b7249986e77057267b01909`. |
| DSpark Markov draft | Reuse the Qwen3.5 0.8B target above with [`satgeze/Qwen3.5-0.8B-DSpark` / `head_q08_v03.gguf`](https://huggingface.co/satgeze/Qwen3.5-0.8B-DSpark/blob/6bc561d7965808faa9ce0028d240b187ff894397/head_q08_v03.gguf) | +438.3 MB | **anchor**, community-published and pinned. This is the compact current `dflash`-architecture path with a block-7 DSpark Markov/confidence head. At ctx 4096 / parallel 1, Arriero projected 408 MiB weights, 40 MiB KV, and 499 MiB compute versus 407.56, 40, and 493.01 MiB from the CUDA server. A real request accepted 15/48 draft tokens. SHA-256 `69e6d56a5873a85112a3f8ae34aaeda4ffb645ebfc0dfa38d01ad20e61e873ce`. |
| Eagle3 extracted-feature draft | Reuse the GPT-OSS 20B anchor below with [`EntityDeletr/EAGLE3-gpt-oss-20b-GGUF` / `EAGLE3-gpt-oss-20b.gguf`](https://huggingface.co/EntityDeletr/EAGLE3-gpt-oss-20b-GGUF/blob/59583c672a860e9d21ed87fff1cf1cf7c4351cd8/EAGLE3-gpt-oss-20b.gguf) | +336.2 MB | **gap canary**, community conversion pinned to a published Eagle3 head. It has one decoder layer and extracts target layers 2/12/21. Weights (308 MiB) and KV (8 MiB) are ordinary draft geometry, but enabling the Eagle3 graph expanded CUDA compute from 533.5 to 797.5 MiB; Arriero currently projects 438 MiB and therefore returns `low` confidence. A real request accepted 16/18 draft tokens. SHA-256 `b48723b81f44317264341df1ac7b95721dde4be88a1bba71ef9387f244c013c5`. |

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

### Known current gaps and oversized candidates

These rows are deliberately recorded even though they cannot be qualified on
the reviewed 31 GiB host. They enter different current llama.cpp memory
implementations and must not be marked covered by the much smaller legacy-MLA
or ordinary-DSpark anchors. Sizes are complete artifact totals, including every
split.

| Missing coverage | Concrete candidate | Smallest relevant download seen | Why it remains distinct |
| --- | --- | ---: | --- |
| MiniMax M3 MSA indexer cache | [`unsloth/MiniMax-M3-GGUF` at `18039c2`](https://huggingface.co/unsloth/MiniMax-M3-GGUF/tree/18039c2c5277fc64109acee91fa3ca3a9da73c57), or the explicitly MSA-labeled [`Serpen/Minimax-M3-MSA-GGUF` at `884b54c`](https://huggingface.co/Serpen/Minimax-M3-MSA-GGUF/tree/884b54cd21c7bc08bc70cb573e5754ef5020c5c7) | 128,417.3 MB (`UD-IQ1_M`); 264,263.5 MB for the MSA Q4_K_M conversion | `minimax-m3` creates an MSA indexer-key cache in addition to attention KV. Neither DeepSeek MLA nor ordinary SWA allocates it. Arriero recognizes the architecture and returns `low` until this cache is modeled and hardware-qualified. |
| DeepSeek V3.2 / DSA indexer cache | [`unsloth/DeepSeek-V3.2-GGUF` / `DeepSeek-V3.2-UD-TQ1_0.gguf`](https://huggingface.co/unsloth/DeepSeek-V3.2-GGUF/blob/a787696863bafd5c736955ef81cc869a0bf6178a/DeepSeek-V3.2-UD-TQ1_0.gguf) | 161,280.8 MB | Current llama.cpp's `deepseek32`/`glm-dsa` path has a DSA indexer cache alongside MLA KV. DeepSeek V2 Lite validates only the earlier MLA layout; Arriero returns `low` for the newer architectures. |
| DeepSeek V4 / DSV4 state and DSV4 DSpark | [`ggml-org/DeepSeek-V4-Flash-0731-GGUF` at `852dfdf`](https://huggingface.co/ggml-org/DeepSeek-V4-Flash-0731-GGUF/tree/852dfdf865e780446372f903924f1f6e22f256f7) | 98,592.5 MB for Q2_K_S target + 10,826.9 MB for the MXFP4 DSpark sidecar | `deepseek4` uses dedicated indexer, recurrent/checkpoint, and MTP-context state. Its DSpark variant also uses DSV4-specific cache geometry, so the 438 MB Qwen DSpark head only covers common draft weights/Markov behavior. The target cannot run on this host; Arriero returns `low` for the target architecture. |
| Multi-head, fused-QKV, and iSWA MTP contexts | Re-check current official model repositories when a small matching target/sidecar pair appears | none manageable found | The qualified Qwen sidecars cover one dense NextN head, and Gemma covers target-shared KV. Extra heads with the same dense geometry scale through metadata, but fused-QKV and iSWA/DSV4 MTP contexts select different cache implementations and remain source-derived rather than equivalent. |

Do not download only a small metadata shard or an affordable draft sidecar and
call a row qualified: the target and sidecar must reach a real current-server
request together, because these paths derive cache and graph geometry from both
contexts.

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
| TQ1_0 and TQ2_0 | Requantize `stories15M.gguf` with current `llama-quantize` | 19.8 MB / 19.8 MB | **format canaries**. Both files contain real ternary tensors despite expected fallback types on the tiny model's 288-wide matrices. They loaded and generated on CUDA; analytical weights were 18 versus 17 MiB from fit (+5.9%). Generated SHA-256 `63db5c3ee67d5c88f64567da6365493133b46356540e93287f846750d7c09117` and `35b3e541e1a543fbab3e561119f213b63733ace450de1565da2bd53ec618131c`. Regenerate after a quantizer format change. |
| Q1_0 and Q2_0 | Requantize the Qwen3-ASR Q8_0 anchor above with current `llama-quantize` | 217.6 MB / 345.2 MB | **format canaries**. Q1_0 weights were 202 versus 201 MiB from fit (+0.5%). Q2_0 initially exposed missing GGML type ID 42 and a dangerous 205 versus 323 MiB underestimate; after adding the trait it is 324 versus 323 MiB (+0.3%). Generated SHA-256 `ab3172ab44454335e844d9a4c3cec5c0a38f43d88f936dd530c49c5e536daa7f` and `b38c2a174e46a53fe9d086e237b885b4ce3c558ea7dd1919af2cedf7ae60306d`. Regenerate after a quantizer format change rather than treating these hashes as permanent upstream artifacts. |
| IQ1_S | RWKV-7 file above | 497.2 MB | **format canary**, locally read and accepted by `llama-fit-params`. |
| IQ2_XS | DeepSeek V2 Lite file above | 5,967.4 MB | **format canary**, locally read and accepted by `llama-fit-params`. |
| MXFP4 MoE | [`ggml-org/gpt-oss-20b-GGUF` / `gpt-oss-20b-MXFP4.gguf`](https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/blob/ef9b12f2ff56c69cf32153a02784e7a3c88bf524/gpt-oss-20b-MXFP4.gguf) | 12,109.6 MB | **format + periodic-SWA anchor** for native MXFP4 MoE and the modern `gpt-oss` layout. Arriero reported no unknown tensor types, its weight sum matched `llama-fit-params` to 1 MiB, and the alternating single-width SWA context matched across the reviewed matrix. SHA-256 `27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`. |
| NVFP4 | [`michaelw9999/Qwen3.5-0.8B-NVFP4-MTP-GGUF` / `Qwen3.5-0.8B-NVFP4-MTP-GGUF.gguf`](https://huggingface.co/michaelw9999/Qwen3.5-0.8B-NVFP4-MTP-GGUF/blob/d8ac925b9b4e19781e3aa8545c69ca89884fcfe4/Qwen3.5-0.8B-NVFP4-MTP-GGUF.gguf) | 578.1 MB | **format anchor only**. Current llama.cpp loaded and generated on CUDA; Arriero found no unknown types and matched fit weights within 0.1%, KV exactly, and compute within 1%. Despite the filename/model card, this exact file has neither `nextn_predict_layers` nor `blk.N.nextn.*`; current llama.cpp rejects it for `draft-mtp`. Do not count it as MTP coverage. SHA-256 `71a0a29da9481f51d8e301f8ffb67feec1627cd18e92183a1f3918b0a7c35728`. |
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

Run `pnpm memory:check-ggml-types` first. It compares Arriero's active tensor
type IDs/names with the managed checkout's current `ggml.h`; pass another
llama.cpp checkout path as the first argument when qualifying an external
binary. The estimator also refuses any GGUF whose tensor table still contains
an unknown type, so a new encoding fails closed instead of producing a
plausible underestimate.

### Derive LoRA and control-vector fixtures

Use llama.cpp's own pinned LoRA test repository instead of searching for a
random adapter compatible with another anchor. The Phi-3 subset is about 49 MB
including source files; the generated F16 base is 10.8 MB and adapter is 2.3 MB.

```bash
FIXTURE_DIR=runtime/models/memory-estimation/lora-tests
LLAMA_SOURCE=runtime/sources/llama.cpp

hf download ggml-org/lora-tests \
  --include 'Phi3ForCausalLM/**' \
  --revision c26d5fb85b4070a9e9c4e65d132c783b98086890 \
  --local-dir "$FIXTURE_DIR"

uv run --project "$LLAMA_SOURCE" "$LLAMA_SOURCE/convert_hf_to_gguf.py" \
  "$FIXTURE_DIR/Phi3ForCausalLM/hidden_size=64/base" \
  --outfile "$FIXTURE_DIR/Phi3ForCausalLM/hidden_size=64/base/Base-F16.gguf" \
  --outtype f16

uv run --project "$LLAMA_SOURCE" "$LLAMA_SOURCE/convert_lora_to_gguf.py" \
  "$FIXTURE_DIR/Phi3ForCausalLM/hidden_size=64/lora" \
  --base "$FIXTURE_DIR/Phi3ForCausalLM/hidden_size=64/base" \
  --outfile "$FIXTURE_DIR/Phi3ForCausalLM/hidden_size=64/lora/Lora-F16-LoRA.gguf" \
  --outtype f16
```

On the reviewed converter the generated base and LoRA SHA-256 are
`470b52dd80cf718ba3fc3b28073b0bff7e9375e6c2915d7b264f818ee88b5182` and
`3c543e921258d381e2eff756953674ae01eb081e00947b43aa155a17e092c5d8`.
Regenerate and re-qualify them when the converter changes.

A zero control vector is enough to exercise loading and permanent allocation
without changing output. Create one F32 `direction.31` vector of width 64 with
the `GGUFWriter` from the same checkout:

```bash
uv run --project "$LLAMA_SOURCE" python - \
  "$FIXTURE_DIR/Phi3ForCausalLM/hidden_size=64/control-vector-zero.gguf" <<'PY'
import sys
import numpy as np
from gguf import GGUFWriter

writer = GGUFWriter(sys.argv[1], "controlvector")
writer.add_tensor("direction.31", np.zeros((64,), dtype=np.float32))
writer.write_header_to_file()
writer.write_kv_data_to_file()
writer.write_tensors_to_file()
writer.close()
PY
```

The reviewed file is 384 bytes, SHA-256
`815148c7acd917b25fa698cbc78f8c53e3792634171b70bcfd7e0739ee989855`.
It loaded together with `--lora-scaled ...:0.5` in the current CUDA server.
The estimator does not use the vector file's payload size: llama.cpp combines
the directions and allocates `(trunk_block_count - 1) * embedding_length * 4`
bytes permanently.

## Launch-argument matrix

Use the following rows as independent test cases. The suggested model is the
smallest one that exercises the relevant branch reliably.

| Branch | Arguments to compare | Suggested artifact | Expected invariant |
| --- | --- | --- | --- |
| Context growth | `--ctx-size 4096`, `16384`, and a value above training context where llama.cpp permits it | `stories15M-q4_0`; Qwen3.5; Gemma 4 | Ordinary KV grows with context; modeled recurrent state does not. |
| Recurrent topology | Compare disjoint attention/state layers, both branches in one layer, short-conv state, and KDA + MLA | Qwen3.5, Falcon-H1, LFM2, Kimi Linear | Tensor names decide which layers receive KV and/or recurrent state. State scales with sequence count, not context length; KDA attention-style projections must not be mistaken for KV. |
| Parallel slots | `--parallel 1` vs `4`, with `--kv-unified` on and off | Qwen3.5 and Gemma 4 | Recurrent state and SWA stream state scale with sequence count; unified global KV does not. |
| Full SWA cache | default vs `--swa-full` at a context larger than the window | TinyGemma or Gemma 4 | Only SWA layers expand from the padded window cache to full `n_ctx_seq`; global/shared-KV rules stay unchanged. On Gemma 4 at ctx 4096, parallel 4, unified KV, the current server reported 54 MiB by default and 72 MiB with `--swa-full`, exactly matching Arriero. |
| KV encodings | Every value printed by current help: `f32`, `f16`, `bf16`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, `q5_1` for both K and V | Qwen3-ASR; TinyGemma for a tiny F16 smoke | KV bytes follow GGML row size. All nine matched fit exactly on Qwen3-ASR. Do not use stories15M for quantized KV because its 48-wide heads are incompatible with 32-element blocks in llama.cpp. |
| Compute | `--ubatch-size 128`, `512`, `1024`; vary `--batch-size` separately | Any model; Gemma 4 stresses the large vocabulary | Dominant compute reservation is linear in `n_vocab * n_ubatch`, not context or parallel slots. |
| Cacheless diffusion | Vary `--ubatch-size`, diffusion steps/block length, and CFG scale; compare fit separately from one real generation | LLaDA 1.5 | Persistent KV stays zero while vocabulary-logit and embedding-width work buffers scale with ubatch. Steps, block scheduling, sampler state, and optional CFG logits are dynamic request memory. Use `llama-diffusion-cli` until the current `llama-server` path passes warmup; do not promote a library-only result to server qualification. |
| CPU, partial, full GPU | `--n-gpu-layers 0`, a finite middle value, and `all`/`999` | `stories15M-q4_0` first, then Qwen3.5 or TinyGemma | Tensor weights move by layer; input embedding remains on host and compute follows the output layer. If `output.weight` is absent, the tied token embedding also appears on the output GPU. Omitted/`auto` GPU layers use a conservative full-offload estimate. |
| KV placement | full GPU offload with and without `--no-kv-offload` | TinyGemma or Qwen3.5 | KV moves to host while weights and compute remain placed by layer. |
| MoE expert placement | full GPU offload; add `--cpu-moe`; then finite `--n-cpu-moe` | `stories15M_MOE-F16` | Only expert tensors in the selected layers move back to host. |
| Multiple GPUs | two or more GPU pools; compare equal and unequal `--tensor-split` | Any dense anchor; repeat with MoE | Layer weights and KV follow the split; compute follows the output layer. Requires a multi-GPU host or a pure analytical pool fixture. |
| Flash attention | `--flash-attn off` vs `on`, including quantized KV | TinyGemma/Qwen3.5 for ordinary attention; DeepSeek for MLA | Ordinary-attention analytical compute stays stable. GPU MLA adds context-sized host staging for Flash Attention or quantized K cache. Compare to the matching binary. |
| Projector | `--mmproj`, then add `--no-mmproj-offload`; send one real request | TinyGemma/Gemma 4 for image; Qwen3-ASR for audio | Projector weights move GPU -> host. Request-time image/audio/video preprocessing and compute remain a flagged omission, so capture pre/post telemetry separately. |
| Draft model | target only vs `--spec-draft-model`; vary `--spec-draft-ngl` and draft cache types | stories15M MoE + stories15M draft | Draft weights, compute and its own KV are added recursively. |
| DFlash | add the official DFlash sidecar with `--spec-type draft-dflash` | Qwen3.6 target + DFlash row | Five-stage draft weights plus its mixed global/iSWA KV and compute are added. `llama-fit-params` cannot initialize this sidecar alone because it requires the target context; compare the live server buffers. |
| DSpark | `--spec-type draft-dspark --spec-draft-n-max 7` | Qwen3.5 0.8B + DSpark row | DFlash-family weights/KV plus the Markov/confidence tensors and graph compute are included. Request-time extracted-feature/sampler scratch remains flagged. |
| Eagle3 | `--spec-type draft-eagle3`; vary ubatch and draft depth | GPT-OSS 20B + Eagle3 row | Extracting three target hidden layers expands the draft compute graph beyond ordinary recursive sizing. This is a `low`-confidence gap canary until the extra buffers have a stable formula. |
| Shared-KV assistant | add the `gemma4-assistant` file with `--spec-type draft-mtp` | Gemma 4 trio | Assistant weights/compute are added, but all four head layers map onto target KV. |
| Separate MTP sidecar | add `--spec-draft-model mtp-…` and `--spec-type draft-mtp` | Official Qwen3.6 pair | Sidecar weights, one-layer NextN KV, and compute are added. Target trunk KV must not include the sidecar layer. |
| Embedded/self MTP | `--spec-type draft-mtp` with no draft path | Qwen3.5-9B embedded-MTP anchor | A second context adds NextN KV/compute but shares the already-resident target weights. Missing `nextn_predict_layers` is a low-confidence configuration error. |
| LoRA/aLoRA | `--lora`, `--lora-scaled`, repeated and CSV forms; optionally `--lora-init-without-apply` | Generate the Phi-3 fixture from `ggml-org/lora-tests` | Every adapter tensor is resident on its base tensor's backend. Scale and initial apply state do not change resident bytes; backend repack/scratch remains flagged. |
| Control vectors | one file, two files, scaled form, and a restricted layer range | Generate a zero F32 `direction.N` fixture for the Phi-3 fixture | llama.cpp combines input files, then allocates one F32 vector for every trunk layer 1..N-1. Scale, file count, and application range do not change that permanent buffer. |
| Split files | monolith vs generated `00001-of-00006` path | `stories15M-q4_0` | Analytical tensor sum and fit projection match the monolith. |
| Explicit parallel default | omit `--parallel`; then set `--parallel 4`; finally add `--kv-unified` | Gemma 4 or GPT-OSS | Auto parallel resolves to four unified slots. An explicit slot count is non-unified unless `--kv-unified` is also passed; Arriero must follow that server rule. |
| Non-layer placement | `--split-mode row`/`none`, `--override-tensor`, draft device/override options | Any GPU anchor | These can invalidate layer-based per-pool placement. Until modeled, the estimate must be `low` confidence rather than silently assigning ordinary layer splits. |
| RPC placement | attach one and then multiple managed `rpc-worker` instances; vary layer/tensor split | Any small dense or MoE anchor | No new GGUF is required: RPC changes tensor backends, staging, and per-machine overhead, not model geometry. Arriero currently reports local draws with `low` confidence and an explicit remote-placement warning; qualify this on a real multi-machine fabric before implementing remote pool draws. |

## Coverage satisfied by equivalence

The following checks often look like they need another download but exercise an
already-qualified byte path. Keep this table current when adding a new row: it
is the guard against an ever-growing collection of near-duplicate models.

| Apparent extra check | Existing coverage | Why another artifact is normally unnecessary |
| --- | --- | --- |
| Q4_K_S vs Q4_K_M, Q5_K_S vs Q5_K_M | Generated tiny-llama K-quants | The preset changes which tensors receive the `q4_K`/`q5_K` type; block byte math is keyed by the tensor type ID, not the filename preset suffix. Keep both only when testing quantizer tensor selection, not estimator sizing. |
| Every IQ/K weight preset on every architecture | TQ1/TQ2, Q1/Q2, IQ1_S, IQ2_XS, K-quant, MXFP4, and NVFP4 canaries | Once a type's block/type size and mixed-tensor sum are checked, model architecture does not alter that tensor's bytes. New GGML type IDs still require a new canary. |
| Separate models for Q4_1/Q5_1/IQ4_NL KV | Qwen3-ASR all-cache-type matrix | Cache bytes use the same `ggmlRowSizeBytes(type, width)` path; all current CLI cache types were compared to fit on one compatible geometry. A new cache type or an incompatible head width is different coverage. |
| A special model for `--swa-full` | TinyGemma/Gemma 4 SWA anchors | This is a launch-time cache-size switch, not a model format. Reuse an existing SWA anchor and compare default/full modes; a non-SWA model cannot exercise it. |
| Long and short spellings of draft cache/offload args | Any ordinary draft or DFlash/DSpark pair plus unit tests | `--spec-draft-type-k/v`, `-ctkd/-ctvd`, and `--cache-type-k/v-draft` select the same draft context fields; likewise, changing only a supported alias needs no new GGUF. Keep argument-remapping tests because this is parser coverage, not model coverage. |
| Another DFlash stage count or DSpark block/rank on ordinary attention | Qualified Qwen DFlash + compact Qwen DSpark | Resident tensors are summed from the file, global/iSWA layer geometry comes from metadata, and Markov/confidence tensors are already included. A different count changes the numbers but not the estimator branch. A DSV4 DSpark is explicitly not equivalent because it selects a different target/cache implementation. |
| Another one-head dense NextN/MTP model | Official Qwen3.6 sidecar + embedded Qwen3.5 MTP | For the ordinary dense path, tensor bytes and per-head KV geometry are metadata-driven; changing target size or the layer index is not new memory logic. Multi-head, fused-QKV, shared-KV, and iSWA/DSV4 variants remain separate checks. |
| Dream, RND1, or another dense LLaDA solely for zero-KV sizing | LLaDA 1.5 plus BERT/reranker encoder anchors | Current Dream, RND1, and dense LLaDA use the same static cacheless-language path: zero persistent KV but vocabulary logits and embedding-width work rows. LLaDA-MoE combines that path with MoE tensor placement already covered by stories15M MoE; download one when dynamic diffusion/CFG memory or real server support is implemented. `wavtokenizer-dec` is not equivalent because its output and request graph geometry differ. |
| A larger LFM2 or LFM2-MoE solely for static state bytes | LFM2-350M + stories15M MoE | Short-convolution state is determined by `embedding_length`, `shortconv.l_cache`, recurrent-layer count, and sequence count. MoE changes resident tensor placement, already covered separately. Add another LFM only for a new state formula, layer filter, or graph-buffer implementation. |
| Another Kimi Linear quant or checkpoint | Qualified Kimi Linear Q2_K | KDA state uses `kda.head_dim`, head count, convolution width, recurrent-layer count, and sequence count; compressed MLA width comes from each projection tensor. Weight quantization is an orthogonal tensor-type axis. A smaller synthetic model would be useful for CI speed, but not for a different byte path. |
| Mamba2 or another standard-SSM hybrid solely for state algebra | Mamba, Qwen3.5, Granite, and Falcon-H1 | Where llama.cpp uses the same `ssm.conv_kernel/group_count/inner_size/state_size` formula, these anchors cover pure recurrent, disjoint hybrid, and same-layer hybrid topology. LFM2 short-conv, Kimi KDA, RWKV, and DSV4 are explicitly not equivalent. |
| Llama, Mistral, and ordinary dense Qwen variants | stories15M plus Qwen/TinyGemma anchors | For unfused dense attention, tensor names provide layer placement and K/V widths directly. Add a family only for a different cache rule, tensor naming scheme, tied output, SWA, recurrent state, or another real branch. |
| A large pre-sharded copy of each architecture | Generated six-shard stories15M | Sharding changes file discovery and tensor-table aggregation, not tensor byte math or architecture geometry. One generated split fixture covers the reader; keep architecture anchors monolithic when possible. |
| A dedicated model solely for RPC | Any existing small dense/MoE anchor | RPC is a placement/backend axis. Reuse an anchor and vary RPC workers and split arguments; add a model only when testing a model-specific cache or adapter path over RPC. |
| Separate projector-weight logic for image, audio, and video | TinyGemma/Gemma image + Qwen3-ASR audio | All mtmd projectors enter the estimator as shard-aware GGUF weights with the same offload switch. Modality-specific request-time buffers are deliberately unmodeled; video becomes a required anchor when that dynamic compute is implemented. |
| More vision towers or audio encoders solely to test resident projector bytes | Gemma/TinyGemma image + Qwen3-ASR audio | Projector architecture changes tensor names and inference graphs, but static residency is the shard-aware sum of all projector tensors on one selected backend. Add an artifact only to model modality-specific request-time graph/preprocessing memory, not to repeat that static sum. |
| `--lora` vs `--lora-scaled`, scale 0 vs 1 | One generated llama.cpp LoRA fixture | Scaling and delayed application alter operations, not loaded adapter tensors. Multiple adapters add linearly, so one real adapter plus a synthetic/repeated-argument test covers residency. |
| One vs many control-vector files and `--control-vector-layer-range` | One zero-vector fixture plus unit tests | Files are summed before application and llama.cpp still allocates one full trunk-layer buffer. Range and strength do not shrink it. |
| N-gram speculative modes | Target model alone | `ngram-*` variants create no resident draft GGUF or second model context, so no additional model download is needed. Their lookup/cache structures can still consume dynamic host RAM and remain a runtime-memory check. |
| Quantization quality/perplexity and tokenizer/chat behavior | Outside this document | They affect output quality or request semantics, not resident tensor/KV byte calculation. They belong in inference compatibility tests. |

These are intentionally **not** equivalences: ordinary draft, embedded MTP,
separate NextN sidecar, Gemma shared-KV assistant, DFlash/DSpark, and Eagle3
have different residency or graph buffers. DSpark shares DFlash's model/KV
reader, but its Markov/confidence tensors and graph still require one real
qualification. MLA/DSA, recurrent state, SWA/shared KV, fused QKV, cacheless
encoders, and cacheless diffusion decoders remain distinct estimator branches.

Hardware coverage is separate from model coverage. At minimum, retain results
from a CPU-only host, a one-GPU host, and a two-or-more-GPU host. Add a NUMA host
only when validating measured RSS or placement; NUMA policy does not currently
change the analytical byte total.

## Download and verification workflow

Arriero's estimator currently requires local `--model`, `--mmproj`, draft,
LoRA, and control-vector paths; `--hf-repo` and `--model-url` are rejected by
the estimation endpoint. A configured but missing LoRA/control-vector file also
fails the estimate instead of being silently omitted.
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
| LFM2 350M | Current CUDA server completed a real request. The estimator identified six attention and ten short-conv recurrent layers; context matched fit at displayed MiB across the entire matrix, weights were +0.4%, and compute was +4.3–5.8%. |
| Falcon-H1 0.5B | Current CUDA server completed a real request. All 36 layers retained both ordinary KV and SSM state; weights matched fit, context stayed within one displayed MiB, and compute differed by -1.4% to -5.3%. |
| Qwen3-ASR 0.6B + audio projector | Loaded on CUDA and transcribed a real MP3. Projector weights were included; process VRAM rose from 2,082 to 2,134 MiB after the request, illustrating the dynamic media buffer that is not yet analytical. Main weights were within +0.1%, KV exact, and compute within 2%. Every current cache type matched fit exactly at displayed MiB. |
| LLaDA 1.5 | The CUDA fit matrix reported 3,012 MiB weights and zero KV exactly. Static compute matched 271 MiB at the default ubatch and was 542 versus 544 MiB at ubatch 1024. `llama-diffusion-cli` generated successfully with CUDA, ubatch 32, four diffusion steps, block length eight, and CFG disabled. The same b10270 `llama-server` build asserted during warmup, so server integration and dynamic diffusion/CFG memory remain open. |
| Granite 4.0 H Micro | Loaded; weights matched displayed MiB and modeled recurrent + attention context matched exactly. |
| Gemma 4 E2B | Loaded as the full model + projector + MTP trio in the CUDA server; logs confirmed MTP cache sharing and a real completion accepted draft tokens. Distinct-width SWA/shared-KV context matched within 0-2 MiB in the non-unified fit matrix. A direct current-server run at ctx 4096, parallel 4, unified KV reported exactly 54 MiB by default and 72 MiB with `--swa-full`. Tied-output GPU weights matched within 1 MiB, and projector/MTP bytes were included by the analytical composite path. |
| Qwen3.5 9B embedded MTP | Current CUDA server created an MTP context against the target's own weights and accepted 17/17 draft tokens. Arriero projected 6,168 MiB of device buffers plus a 400 MiB margin; NVML observed 5,740 MiB. |
| Qwen3.6 27B + official MTP sidecar | Current CUDA server loaded the 64-layer target and one-layer NextN sidecar and accepted 17/17 draft tokens. Arriero projected 19,888 MiB of device buffers plus a 400 MiB margin; NVML observed 19,814 MiB. |
| Qwen3.6 27B + official DFlash sidecar | Current CUDA server loaded all five DFlash stages and accepted 17/17 draft tokens. At ctx 4096 / parallel 1 its sidecar buffers were 1,753.36 MiB weights + 56 MiB mixed global/iSWA KV + 511.52 MiB compute. Arriero projected 1,753 + 56 + 553 MiB (+1.8% in aggregate). The feature-extraction/sampler scratch outside the model breakdown remains flagged. |
| Qwen3.5 0.8B + DSpark | Current CUDA server loaded the block-7 Markov/confidence head and accepted 15/48 draft tokens. The sidecar projection was 408 MiB weights + 40 MiB KV + 499 MiB compute versus 407.56 + 40 + 493.01 MiB in the log. This closes DSpark's stable model buffers; request-time scratch stays a warning. |
| GPT-OSS 20B + Eagle3 | Current CUDA server loaded the one-layer sidecar, extracted target layers 2/12/21, and accepted 16/18 draft tokens. Stable weights/KV were 308/8 MiB, but Eagle3 activation expanded its CUDA compute from 533.5 to 797.5 MiB while Arriero projects 438 MiB. Retained as a `low`-confidence gap canary. |
| DeepSeek V2 Lite | Loaded; legacy MLA context matched exactly at displayed MiB for every F16/Q8_0/Q4_0 case. GPU host staging closed the large quantized-KV/Flash-Attention compute omission; aggregate compute is within -3.6% to +5.1%. |
| Kimi Linear 48B A3B | The current CUDA server loaded the 18.0 GB Q2_K file and completed a real request. Arriero separated seven compressed-MLA layers from 20 KDA layers despite their attention-like projection names. Weights were exact after displayed rounding; context was 203 versus 202 MiB at 4k, exact at 297/238 MiB for 16k F16/Q8_0, and within one MiB for Q4_0; compute was +1.7–3.5%. NVML was 17,494 MiB before and 17,500 MiB after the request. |
| tiny GPT-2 | Loaded; fused-QKV context matched exactly at displayed MiB. |
| e5-small-v2 | Loaded; non-causal classification now produces zero persistent KV exactly; compute is within 1 MiB at default ubatch and exact at ubatch 1024. |
| Jina tiny reranker | Loaded; classifier detection now produces zero persistent KV exactly and compute 12 versus 11 MiB at default ubatch, then 24 MiB exactly at ubatch 1024. |
| Mamba 130M and RWKV-7 | Loaded; recurrent-state projections are within one displayed MiB of fit for both architectures. |
| GPT-OSS 20B MXFP4 | Loaded on CPU and CUDA builds with no unknown tensor types; analytical weights matched `llama-fit-params` to 1 MiB and alternating single-width SWA context matched across the matrix. |
| Qwen3.5 0.8B NVFP4 | Loaded and generated on CUDA; weights were within 0.1%, KV exact, and compute within 1%. The artifact has no MTP metadata/tensors despite its name, and `draft-mtp` was correctly rejected. Counted only for NVFP4. |
| Generated TQ1_0 / TQ2_0 stories15M | Both contain ternary tensors, loaded, and generated eight CUDA tokens. Analytical weights were 18 versus 17 MiB from the CUDA fit projection (+5.9%); ordinary F16 KV remained exact. The expected fallback mix is part of the canary, not a claim that every tensor is ternary. |
| Generated Q1_0 / Q2_0 Qwen3-ASR | Both loaded in fit. Q1_0 weights were +0.5%; Q2_0 is +0.3% after adding type ID 42. The pre-fix Q2_0 result undercounted weights by 36.5%, which is why unknown types now fail closed. |
| llama.cpp Phi-3 LoRA + zero control vector | Generated from pinned `ggml-org/lora-tests`. The 2,318,336 adapter tensor bytes were included exactly, `/lora-adapters` reported the loaded adapter, generation completed, and the zero vector loaded together with the scaled LoRA. |
| old Microsoft BitNet `i2_s` | Arriero read the header but could not account for all tensor types; current llama.cpp rejected the removed encoding. Quarantined. |

The CUDA matrix reproduced the same context results for the dense, MoE, Qwen,
LFM2, Falcon-H1, Kimi Linear, Granite, Gemma, DeepSeek, GPT-OSS, and cacheless
LLaDA rows. A per-device comparison closed the
one-GPU tied-output rule and calibrated MLA host staging. Multi-GPU splits,
non-CUDA backends, and the fixed per-GPU context margin remain source-derived
conservative approximations rather than hardware-qualified invariants.

The qualification servers above used `--cache-ram 0 --ctx-checkpoints 0` so
their buffer comparisons isolate model/context/compute residency. Current
`llama-server` defaults to an 8192 MiB **limit** for the lazily populated RAM
prompt cache, 32 per-slot context checkpoints, and idle-slot caching. Those are
request-history-dependent host allocations, not an 8 GiB startup reservation;
measure them separately for peak-RAM qualification.

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
4. Run `pnpm memory:check-ggml-types`, then download and require
   `unknownTypeIds: []` before accuracy comparisons. A parsed GGUF header alone
   is not enough; unknown types must make the estimate fail.
5. Run `pnpm memory:calibrate` with the same llama.cpp revision as the server
   binary, plus the composite API path for projector and draft cases.
6. Update the reviewed date and qualification outcome. Preserve an old row as
   **quarantine** when it is useful for recognizing a compatibility break;
   otherwise replace stale links rather than accumulating near-duplicates.
7. Keep individual sizes, but do not add or maintain a total-size claim. The
   menu is meant to remain modular as model families change.
8. Record apparent-but-equivalent candidates in “Coverage satisfied by
   equivalence” instead of silently skipping them or adding redundant files.
