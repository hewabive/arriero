# Memory estimation

The memory estimator predicts how much memory a managed `llama-server`
**instance** will use in a specific configuration (model + launch args), broken
down per memory pool and per category, **before** the process is launched. Its
output is `InstanceMemoryDraw[]`, the same shape instances declare for the
capacity ledger (`docs/RESOURCE_MANAGEMENT.md`), so an estimate can be applied
directly as an instance's declared footprint.

For vLLM, the `vllm-gpu-util` strategy uses the engine's reservation contract
instead of inspecting model tensors: each selected GPU draw is
`--gpu-memory-utilization` times that pool's capacity. The argument must be
explicit because its upstream default is version-dependent (`0.9` in older
releases and `0.92` in vLLM 0.26.0). GPU order comes from
`CUDA_VISIBLE_DEVICES`, limited by `--tensor-parallel-size`. The ratio is
applied independently per device, never divided across the tensor parallel
group. Host RAM is intentionally left as a manual draw.

It is **per-instance, not per-model**: the estimate depends on the instance's
own args (`--ctx-size`, `--cache-type-k/v`, `--n-gpu-layers`, `--parallel`, …)
and its selected current binary.

The server's parallel/KV default is conditional. With no explicit
`--parallel`, current `llama-server` resolves auto to four slots and enables
unified KV. Supplying an explicit slot count leaves KV non-unified unless
`--kv-unified` is also supplied. The estimator mirrors this distinction;
`--parallel 4` and auto-parallel are not interchangeable configurations.

## Two engines

1. **Analytical** (implemented) — a pure, side-effect-free engine in
   `@arriero/core` (`packages/core/src/memory-estimate.ts`). It reads the
   GGUF tensor table + metadata and the launch args and computes the breakdown
   with no I/O. Instant, works headless, deterministic, unit-tested.
2. **Dry-run anchor** (binary present, used for calibration; a future "measured"
   API mode) — `llama-fit-params -fitp on` loads the model with `no_alloc=true`
   (no tensor allocation, no warmup) and prints the projected
   `device model context compute` in MiB. This is llama.cpp's own projection and
   is the accuracy anchor the analytical engine is calibrated against. The build
   produces `llama-fit-params` as a non-fatal companion of `llama-server`
   (`apps/api/src/build/runner.ts`) so a version-matched binary sits next to each
   built server.

## Inputs

- **GGUF tensor table** — `apps/api/src/models/gguf.ts:readGgufTensorTable`
  returns every tensor's name, ggml type and dims; bytes are computed with the
  ggml type traits in `packages/core/src/ggml.ts`. Active IDs/names are checked
  against the current checkout with `pnpm memory:check-ggml-types`; block/type
  sizes are unit-tested against upstream row math. A GGUF containing an unknown
  tensor type is rejected rather than treating its tensors as zero bytes. The
  per-tensor sum reproduces the on-disk file size
  to within the GGUF metadata/alignment overhead (~0.4–1.4%). **Multi-part
  (split) GGUFs** are read across every shard: `readGgufModelTensorTable`
  detects a `…-00001-of-000NN.gguf` path (`models/split.ts`), enumerates the
  sibling shards and sums their tensor tables (metadata still comes from shard 1).
  Reading only the first shard would undercount weights and per-layer KV — for a
  4-shard model the tensor sum jumps from ~14.8 GiB to the full ~46 GiB,
  matching the `llama-fit-params` `model` column.
- **GGUF metadata** — architecture, block count, embedding length, head counts,
  key/value head lengths (including MLA), causal-attention mode, context length,
  sliding-window pattern, recurrent/SSM geometry, vocabulary size, RWKV state
  geometry, and `nextn_predict_layers` for embedded or sidecar MTP.
- **Args** — parsed into resolved context params (`resolveContextParams`):
  `n_ctx`/`n_ctx_seq`/`n_batch`/`n_ubatch`/`n_seq_max`/`kv_unified`/`flash_attn`/
  cache types/`offload_kqv`/`n_gpu_layers`, matching `llama-server`'s defaults
  (parallel=4, kv_unified=true, ctx padded to 256, cache type f16). Local
  `--mmproj`, draft, LoRA, scaled-LoRA, control-vector, and scaled-control-vector
  paths select the auxiliary resident artifacts/buffers.
- **Pools** — gpu/host pools from `config/resources.json`; placement maps each
  tensor and KV layer to a pool.

## Categories

- **Weights** — sum of per-tensor bytes, placed across pools by `-ngl`/`-ts`/
  `--cpu-moe`/`--n-cpu-moe`. The input embedding stays on the host and the
  output follows the output layer. When `output.weight` is absent under GPU
  offload, llama.cpp uses the tied `token_embd.weight` as output and creates a
  second device copy; the estimator includes both copies. This is the
  **resident** footprint (mmap'd weights occupy page-cache RAM and must stay
  resident to run without thrashing) — see the calibration note below.
- **KV cache** — uses each cache-bearing layer's actual geometry. Separate
  `blk.N.attn_k/v.weight` tensors supply the dimensions directly; fused GPT-2
  `attn_qkv` and MLA `attn_kv_a_mqa` layouts derive them from the metadata head
  counts and key/value lengths. Bytes are
  `ggmlRowSizeBytes(cache_type, width) * n_ctx_seq * n_stream` for K and V.
  Compressed MLA stores K only; legacy MLA stores K and V. This correctly counts
  only attention layers in hybrid models. It matches `llama-fit-params` to the
  displayed MiB across the dense, fused GPT-2, legacy DeepSeek MLA, and
  quantized-cache anchors.
- **Sliding-window attention (SWA) + KV sharing** — for SWA architectures with
  distinct global/SWA head dims (e.g. Gemma 3n/`gemma4`), SWA layers (the smaller
  `attn_k` dim) are capped at the window instead of the full context. The current
  iSWA allocation is
  `pad(min(n_ctx_seq, sliding_window * (kv_unified ? n_seq_max : 1) + n_ubatch), 256)`
  cells, multiplied by one stream for unified KV or `n_seq_max` streams otherwise.
  `--swa-full` replaces that cell count with full `n_ctx_seq`. When
  `*.attention.shared_kv_layers` is set,
  the last `shared_kv_layers` layers reuse earlier layers' cache and allocate
  none, so only `block_count - shared_kv_layers` layers count. Reproduces the
  non-unified `llama-fit-params` `context` column to the MiB across context sizes,
  cache types, `--ubatch-size` and `--parallel`. For the server-only unified mode,
  Gemma 4 at ctx 4096 / parallel 4 reported exactly 54 MiB by default and 72 MiB
  with `--swa-full`, matching the analytical result. Explicit GGUF
  boolean patterns and scalar periods are honored even when every layer has the
  same width. Known metadata-default periods are supplied for Gemma 2/3/3n and
  GPT-OSS. Unknown single-width layouts remain a full-context upper bound with
  a warning.
- **Recurrent state** — for hybrid/SSM architectures (e.g. Qwen3-Next/`qwen35`,
  Mamba), each recurrent layer holds a fixed-size state cache instead of a KV
  cache: `(n_embd_r + n_embd_s) * 4 bytes` per layer **per sequence**, where
  `n_embd_r = (d_conv-1)*(d_inner + 2*n_group*d_state)` (conv state) and
  `n_embd_s = d_state*d_inner` (SSM state), read from the `*.ssm.*` GGUF
  hyperparameters. Unlike attention KV under `kv_unified`, this scales linearly
  with `--parallel` (one copy per sequence). It is folded into the KV/context
  category and reproduces `llama-fit-params`' `context` column to the MiB across
  context sizes, cache types and parallelism (verified on `qwen35` and Granite).
  Pure Mamba follows llama.cpp's zero-group default when `ssm.group_count` is
  absent. LFM2 short-convolution layers instead use
  `n_embd * (shortconv.l_cache - 1) * 4`; Kimi Linear KDA uses
  `[3*(d_conv-1)*n_head*kda_head_dim + kda_head_dim^2*n_head] * 4` per layer
  and sequence. Kimi's recurrent Q/K/V projection tensors are explicitly
  excluded from token KV; only its compressed-MLA layers receive a K cache.
  RWKV uses `(token_shift_count*n_embd + n_embd*wkv_head_size) * 4` per layer
  and sequence. Falcon-H1 confirms that attention KV and recurrent state may
  coexist in the same layer. If the required geometry is still absent, the
  state is left unmodeled and confidence drops to `low`.
- **Specialized current caches** — MiniMax M3's MSA indexer-key cache,
  DeepSeek V3.2/GLM-DSA's DSA indexer cache, and DeepSeek V4's dedicated
  indexer/recurrent/checkpoint state are separate llama.cpp allocations. They
  are not implied by a successful legacy-MLA or recurrent-state check. Arriero
  detects `minimax-m3`, `deepseek32`/`glm-dsa`, and `deepseek4` and returns
  `low` with an architecture-specific warning until a full formula is
  hardware-qualified.
- **Compute** — the logits projection, `n_vocab * n_ubatch * 4`, plus activation
  buffers sized from the largest embedding/FFN expansion width. Non-causal
  encoders and classifier heads omit decoder logits and use their activation
  envelope; they also allocate no persistent KV. Cacheless diffusion language
  decoders (`llada`, `dream`, `rnd1`) likewise allocate zero persistent KV, but
  retain vocabulary logits and three embedding-width work rows. LLaDA matched
  the pinned fit projection at 271 MiB for the default ubatch and within 2 MiB
  at ubatch 1024. Diffusion scheduling, sampler state, and optional CFG logits
  remain dynamic and are flagged. GPU MLA with Flash Attention or quantized K
  cache adds its context-sized host staging rows, matching the otherwise-hidden
  RAM reservation. The result is a reservation projection, not the subset of
  pages touched in host RSS.
- **Multimodal projector (`--mmproj`)** — an image/audio/video adapter is a
  separate GGUF that `llama-server` loads alongside the model. Its
  weights (the per-tensor sum of the projector file, read via the shard-aware
  reader) are folded into the footprint: on the **GPU** by default, on the
  **host** when `--no-mmproj-offload` is set. The projector has no KV cache; the
  request-time media decode/preprocess/compute buffers are not modeled
  (flagged). `llama-fit-params` cannot anchor this — it rejects `--mmproj` — so
  projector weights are analytical-only. Surfaced as `mmprojBytesTotal` and
  qualified with both image (Gemma) and audio (Qwen3-ASR) requests.
- **Speculative draft model (`--spec-draft-model`/`-md`)** — a second resident
  model loaded for speculative decoding. It is estimated recursively by the
  **same engine** over the draft GGUF, with the draft-specific args remapped onto the
  standard keys (`--spec-draft-ngl`→`-ngl`, `--spec-draft-type-k/v`→cache types;
  context/parallel/batch shared with the target). Its weights + KV + compute are
  added to per-pool draws and reported as `draftBytesTotal`. For a separate
  NextN sidecar, only the final `nextn_predict_layers` enter that context's KV;
  the target trunk does not allocate cache for them. The official Qwen3.6 pair
  is the anchor. `gemma4-assistant` is a separate special case: all four
  assistant layers share target global/SWA KV, so its contribution is weights +
  compute and no duplicate persistent KV. Current server logs confirmed each
  sharing mapping. Current aliases `-ctkd`/`-ctvd` and
  `--cache-type-k/v-draft` are remapped too, and the global `--swa-full` mode is
  inherited by the draft context just as it is in llama.cpp.
- **DFlash and DSpark drafts** — both use the normal recursive draft tensor
  sum and metadata-derived mixed global/iSWA KV. DFlash was qualified at
  1,753/56/553 MiB analytical weights/KV/compute versus
  1,753.36/56/511.52 MiB from the server. The compact Qwen3.5 DSpark head,
  including its Markov/confidence tensors, was 408/40/499 MiB versus
  407.56/40/493.01 MiB. Request-time extracted-feature and sampler vectors are
  still dynamic and flagged, but the stable model buffers remain `medium`
  confidence.
- **Eagle3 draft** — weights and ordinary one-layer KV are included, but its
  target-hidden-state extraction and verification graph are not yet modeled.
  On the reviewed GPT-OSS pair, enabling Eagle3 expanded draft CUDA compute
  from 533.5 to 797.5 MiB while the generic analytical result was 438 MiB.
  `draft-eagle3` therefore forces `low` confidence instead of presenting the
  recursive draft estimate as complete.
- **Embedded/self MTP (`--spec-type draft-mtp` without a draft path)** —
  llama.cpp creates an `LLAMA_CONTEXT_TYPE_MTP` context against the target model
  itself. Weights are already resident and are not counted twice; NextN KV and a
  second compute reservation are reported as `selfMtpBytesTotal`. The target's
  normal context excludes the last `nextn_predict_layers` from its cache. If the
  metadata/layer tensors are absent, confidence is `low` and the warning mirrors
  the configuration error that current llama.cpp rejects. Verified with an
  embedded one-layer Qwen3.5 model and a real accepted-draft request.
- **LoRA/aLoRA (`--lora`, `--lora-scaled`)** — every adapter GGUF tensor stays
  resident and follows the backend placement of its corresponding base tensor.
  Repeated/CSV arguments and scaled forms are all read; scale and
  `--lora-init-without-apply` do not change loaded bytes. Multiple adapters add
  linearly and are reported as `loraBytesTotal`. Backend repack/fallback copies
  and adapter graph scratch are not analytically derivable and remain flagged.
- **Control vectors (`--control-vector`, scaled form)** — source files are
  loaded and combined, then llama.cpp permanently allocates one F32 vector for
  each target trunk layer from 1 through `n_layer()-1`, placed with that layer.
  File count, scale, and `--control-vector-layer-range` do not shrink this
  allocation. Reported as `controlVectorBytesTotal`; embedded NextN layers are
  excluded because the adapter is initialized against `n_layer()`, not
  `block_count`.
- **Dynamic server RAM (not in `totalBytes`)** — current `llama-server`
  defaults to an 8192 MiB limit for a lazily populated serialized prompt-state
  cache, 32 per-slot context checkpoints, and idle-slot caching. The limit is
  not reserved at startup: actual host RAM depends on request history, target
  and draft state sizes, and eviction. N-gram speculative lookup/cache data is
  dynamic for the same reason. Static qualification should use
  `--cache-ram 0 --ctx-checkpoints 0`; peak-runtime qualification must measure
  these mechanisms separately.
- **Overhead** — a per-GPU CUDA-context margin (rough constant, flagged), added
  once per GPU pool that holds any bytes (so draft/projector/adapter contexts
  share the process CUDA context rather than each receiving another margin).

## Confidence and warnings

`MemoryEstimate.confidence` is `high` for plain dense/MoE transformers, `medium`
when sliding-window attention, modeled MLA/recurrent state, cacheless roles, or
GPU placement is involved, and `low` when a detected cache/state/MTP layout
cannot be modeled. Eagle3, the recognized MSA/DSA/DSV4 architectures, non-layer
split modes, tensor backend overrides, RPC devices, and separate
draft-device/override placement currently force `low`. Unknown tensor
types do not return a low-confidence number:
they fail the estimate outright. Warnings say whether SWA is capped or only an
upper bound, whether recurrent/MLA/MTP state was included, which auxiliary
scratch is omitted, when upstream automatic GPU placement is represented by
conservative full offload, and which GPU assumptions remain.

## Instance assessment and drift detection

A successful GGUF estimate also creates a local assessment receipt. The form
binds that receipt to the instance when the configuration is saved. Receipts
live in `data/arriero.db`, not in the portable instance configuration: they are
evidence produced on one machine and must not migrate to a different machine.

The receipt fingerprints:

- `MEMORY_ESTIMATOR_VERSION` and the current estimator id;
- memory-affecting args, environment, and managed RPC-worker references (stored
  as a digest, not as plaintext);
- the selected `llama-server` and adjacent llama.cpp runtime libraries;
- the main GGUF, every split shard, draft GGUF, mmproj, every LoRA, and every
  control-vector file by path, size, and modification time;
- the selected memory-pool hardware.

Arriero supports one current estimator/binary pairing. It does not keep
historical formulas for old llama.cpp revisions. The selected server must match
the binary Arriero currently resolves as its default (normally the managed
`master` build). A changed estimator, binary/runtime library, model artifact,
configuration, hardware fingerprint, or newly selected current binary makes the
receipt `update-required`.

When a bound instance reaches `running` + ready with no launch-configuration
drift, Arriero compares the analytical GPU and host allocation to exact
llama.cpp `* buffer size` log lines. The comparison excludes the estimator's
CUDA-context overhead because that is not a llama.cpp buffer allocation. An
absolute difference above `max(128 MiB, 8%)` marks the assessment `mismatch`;
otherwise it becomes `verified`. Process RSS/NVML telemetry and host projections
remain useful operational telemetry but are not precise enough to verify the
buffer-level estimate. A completed validation remains visible after the process
stops, until its fingerprint becomes stale.

Instance health exposes `not-assessed`, `analytical`, `verified`, `mismatch`, or
`update-required`, plus whether the estimated draws were applied and remain
unchanged. `mismatch` and `update-required` tell the administrator to update both
Arriero and llama.cpp, rebuild the current `llama-server` /
`llama-fit-params` pair, and reassess. If drift remains, the instance details
page exports a redacted JSON report for a developer. Maintainers must increment
`MEMORY_ESTIMATOR_VERSION` whenever estimator semantics change so old receipts
fail closed instead of silently retaining an obsolete result.

## API

`POST /api/memory-estimate` (`apps/api/src/memory-estimate/`):

- body:
  `{ instanceId?, kind?, binaryPathRefId?, args?, positionalArgs?, env?, rpcWorkers? }`
  — load an existing instance's inputs, and/or pass preview inputs; preview args
  and RPC-worker references override.
- `200 { data: { modelPath, estimate, assessmentId } }` on success. The
  assessment id is non-null for a supported `llama-server` GGUF assessment.
- `422 { error }` for routers (`--models-preset`), remote models
  (`--hf-repo`/`--model-url`), a missing model/LoRA/control-vector file, an
  unsupported GGML tensor type, or an unknown instance.

`POST /api/instances/:id/memory-assessment` with `{ assessmentId }` binds the
receipt after rechecking its complete fingerprint. `GET
/api/instances/:id/memory-assessment/report` returns the diagnostic report;
sensitive argument/environment keys are redacted.

The instance form surfaces this as an "Estimate footprint" panel with the
per-pool breakdown and an "Apply as draws" button
(`apps/web/src/ui/components/InstanceFormMemoryEstimate.tsx`).

## What the estimate targets: fit-params, not RSS

The analytical engine is a **conservative `llama-fit-params` projection**, not a
predictor of resident set size (RSS). This is deliberate: per-instance RSS on the
host is not derivable from the GGUF alone (see the host-RSS note below), so the
estimator over-projects in a way that stays safe for "will it fit / will it swap"
admission. True per-instance RSS is the job of the future **measured engine**
(probe the real binary), not this analytical path.

### Host-RSS investigation (2026-06-19, CPU box) — why compute stays at the fit reservation

Triggered by the gemma-4-E2B MTP draft test, a full RSS + `llama-fit-params`
sweep (gemma Q3_K_S, qwen2.5-0.5B Q4_0, SmolLM2-360M Q4_K_M) established:

- **Compute is two different numbers.** The compute buffer is *reserved* at
  `~n_vocab × n_ubatch × 4` (the fit-params `compute` column; gemma ub128/512/1024
  → 145/581/1164 MiB, linear in `n_ubatch`, independent of `n_ctx`), but only
  `~n_vocab × n_ubatch × 1 byte` ever becomes *resident* (RSS-touched; gemma ub512
  → 116 MiB, since real `n_outputs` is tiny so most of the reserved logits buffer
  is never written). The engine reports the **reserved** number — it is what GPU
  VRAM actually needs, and on the host the reserved-but-untouched pages are
  overcommitted (no swap).
- **Resident weights are not analytically predictable.** On the CPU backend
  (`REPACK=1`) the resident weight footprint is dominated by quant-dependent
  repack: gemma Q3_K +7% over the tensor sum, SmolLM Q4_K +20%, qwen0.5 Q4_0
  **+77%** (RSS idle 713 MiB vs tensor sum 403 — the repacked copy is held
  alongside the mmap original). The `fit-params` `model` column is itself
  unreliable here (qwen0.5 reports 211, *excluding* layer weights). No single
  factor over the GGUF tensor sum is safe.
- **Linux nuance:** mmap'd weights (our tensor-sum number) are reclaimable
  file-backed page cache — they do **not** cause swap; the anonymous repack copies
  do. So the "correct" host number is neither the tensor sum nor the fit `model`.
- **The conservatism is load-bearing.** The compute over-projection
  (reserved `×4` ≫ touched) roughly *cancels* the weight under-projection
  (tensor-sum < resident), and both scale with model/vocab — so the instance-level
  estimate stays conservative across models without modeling either precisely.
  Calibrating compute down to the RSS-touched value **in isolation** would break
  this and make the host total unsafe. This is why the draft compute is kept at
  the target's `n_vocab × n_ubatch × 4` (a `--parallel`-capped variant was tried
  and reverted).

### Open items

1. **GPU CUDA-context overhead** — replace the rough per-GPU constant with a
   measured value.
2. **Compute residuals** — the width-based activation envelope is within roughly
   0–5% on the reviewed one-GPU Qwen3.5, Gemma 4, DeepSeek MLA, and TinyGemma
   matrix, but architecture/backend outliers remain (for example Granite on the
   reviewed CPU build). Refine per-architecture buffers only when a gold
   `llama_memory_breakdown_print` table explains the difference.
3. **Measured engine** — to report real host RSS (vs the conservative projection),
   probe the actual instance: resident weights (repack + mmap reclaim), compute
   touched, base process overhead. Not derivable analytically.
4. **Request-time multimodal memory** — projector weights are resident and
   modeled, but image/audio/video preprocessing and graph buffers can grow only
   after media arrives. Qwen3-ASR rose by about 52 MiB after a real request on
   the reviewed CUDA host. Model this only after mtmd exposes stable geometry or
   a measured request probe exists.
5. **Eagle3 compute** — weights and ordinary KV are correct, but the target
   hidden-state extraction/verification graph added about 375 MiB beyond the
   generic compute projection on the reviewed GPT-OSS pair. Derive it from
   stable graph geometry or a measured breakdown before raising confidence.
6. **MSA/DSA/indexer and DeepSeek-V4 memory** — legacy/compressed MLA is
   modeled, but MiniMax M3's MSA indexer-key cache, the newer DSA indexer cache,
   and DSV4-specific state are separate allocations. The smallest candidates
   reviewed were about 128.4 GB for MiniMax M3, 161.3 GB for DeepSeek V3.2, and
   98.6 GB for a DeepSeek V4 target before its 10.8 GB DSpark sidecar. They do
   not fit this host; retain them as explicit `low`-confidence gaps rather than
   treating DeepSeek V2 Lite or compact Qwen DSpark as equivalent.
7. **Additional MTP cache families** — one-layer dense Qwen NextN, embedded
   MTP, and Gemma shared-KV assistant are hardware-qualified. Multi-head
   NextN, fused-QKV and iSWA MTP variants remain source-derived until a
   manageable current artifact can be run on matching hardware.
8. **Dynamic server caches** — prompt RAM cache, context checkpoints, idle-slot
   snapshots, and n-gram structures are request-history-dependent and excluded
   from the static total. Add a measured peak mode rather than counting the
   8192 MiB default prompt-cache limit as if it were eagerly reserved.
9. **Non-layer and RPC placement** — `--split-mode row`/`none`/`tensor`,
   main-GPU selection, `--override-tensor`, separate draft device/tensor
   overrides, and RPC workers can change per-pool placement. They currently
   fail confidence closed with an explicit warning; for RPC, displayed draws
   cover local pools only and omit remote-device overhead/client staging. The
   aggregate tensor byte sum may still be useful.
10. **Diffusion request and server integration** — cacheless language-model
    weights, zero KV, and stable logits/activation buffers are fit-qualified,
    and LLaDA completed a real CUDA generation through `llama-diffusion-cli`.
    Request scheduling, sampler/CFG allocations, and peak memory are still
    dynamic. The reviewed b10270 `llama-server` asserted during LLaDA warmup,
    so this branch must not be presented as a normal Arriero server instance
    until the newest server path itself passes an end-to-end request.

**Closed against the pinned CPU/CUDA `llama-fit-params`:**

- Hybrid recurrent state (RS) cache (`qwen35`/Qwen3-Next), modeled from the
  `*.ssm.*` hyperparameters; matches the `context` column to the MiB across
  context sizes, cache types and `--parallel`.
- SWA + KV-sharing cache (`gemma4`/Gemma 3n): SWA layers capped at the iSWA
  window (or expanded by `--swa-full`), `shared_kv_layers` reused layers dropped;
  matches the non-unified fit matrix and the current server's unified default/full
  memory breakdown exactly in the reviewed 4k/parallel-4 case.
- Single-width periodic SWA for Gemma 2/3/3n and GPT-OSS, using GGUF patterns or
  the architecture's llama.cpp default period.
- Fused GPT-2 QKV, legacy/compressed MLA geometry, cacheless encoders and
  classifier heads, cacheless diffusion's stable zero-KV/logits buffers, pure
  Mamba without `ssm.group_count`, and RWKV state. Dynamic diffusion memory and
  `llama-server` integration remain open as described above.
- Recurrent topology and alternate state formulas: LFM2 short-convolution,
  Falcon-H1 same-layer attention + SSM, and Kimi Linear KDA + compressed MLA.
  All matched context fit to the displayed MiB (or within one MiB) and completed
  a current CUDA server request.
- One-GPU tied-output placement: Qwen3.5 projects 497 MiB device + 199 MiB host
  weights versus 497 + 198 MiB from the pinned CUDA binary. Gemma 4 and
  TinyGemma exercise the same duplication rule.
- MLA GPU host staging for Flash Attention and quantized KV. DeepSeek V2 Lite's
  analytical context is exact at displayed MiB across the matrix; aggregate
  compute differs by -3.6% to +5.1%.
- Current GGML type IDs through Q2_0, with explicit fail-closed handling for an
  unknown tensor type. Generated TQ1_0/TQ2_0 and Q1_0/Q2_0 canaries all load in
  the current CUDA runtime; Q1/Q2 match fit weights within 0.5%, while the tiny
  mixed-type TQ files are +5.9%. `pnpm memory:check-ggml-types` catches additions
  to `ggml.h`.
- MTP residency variants: embedded Qwen shares weights but adds KV/compute;
  official Qwen3.6 sidecar adds weights + one-layer KV + compute; Gemma 4
  assistant shares target KV. All three reached the current CUDA server, and
  both Qwen variants accepted draft tokens.
- DFlash and DSpark stable sidecar buffers. DFlash mixed global/iSWA KV matched
  exactly and its aggregate analytical sidecar projection was +1.8%; the
  compact DSpark head matched weights/KV and compute within 1.2%. Both accepted
  draft tokens in the current CUDA server. Eagle3 remains open and deliberately
  `low` confidence.
- Conditional unified-KV defaults: auto parallel means four unified slots,
  while an explicit `--parallel N` remains non-unified unless `--kv-unified`
  is set. Draft cache aliases and the inherited `--swa-full` mode are covered
  by unit tests.
- LoRA tensor residency and control-vector permanent buffer formula, including
  scaled/repeated CSV paths and assessment artifact fingerprints.

## Running the calibration harness

`scripts/memory-estimate-calibrate.mjs` runs the analytical engine and
`llama-fit-params` over a config matrix and prints a comparison table (and JSON
with `--out`). Build first (`pnpm build`), then:

`llama-fit-params` does not expose the server's `--kv-unified` switch. The
harness therefore forces the analytical side to non-unified KV for an honest
comparison and records that mode in JSON. Qualify unified KV and `--swa-full`
against a real `llama-server -v` `common_memory_breakdown_print` table.

For a maintained menu of concrete dense, MoE, hybrid, SWA, MLA, multimodal,
draft, classic and exotic GGUF artifacts, including known-gap canaries, see
[`GGUF_MEMORY_TEST_MODELS.md`](GGUF_MEMORY_TEST_MODELS.md).

```bash
# First detect an upstream GGML enum addition/removal:
pnpm memory:check-ggml-types

# CPU box (analytical vs fit-params projection):
pnpm memory:calibrate --out tmp/calib-cpu.json

# GPU machine (adds GPU-offload configs; --gpus = device count):
pnpm memory:calibrate --gpus 1 --out tmp/calib-gpu.json
```

Flags: `--models <dir>` (default `runtime/models`), `--fit-params <path>`
(default the built companion), `--gpus N`, `--only <substr>`, `--out <file>`,
or pass explicit `*.gguf` paths. On the GPU machine, share back the JSON plus,
ideally, the gold `llama_memory_breakdown_print` table and per-pid RSS for a few
real runs so the remaining open items above can be closed.
