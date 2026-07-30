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
and, for the future measured path, its own pinned binary.

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
  ggml type traits in `packages/core/src/ggml.ts` (block/byte sizes extracted
  from the built `libggml`). The per-tensor sum reproduces the on-disk file size
  to within the GGUF metadata/alignment overhead (~0.4–1.4%). **Multi-part
  (split) GGUFs** are read across every shard: `readGgufModelTensorTable`
  detects a `…-00001-of-000NN.gguf` path (`models/split.ts`), enumerates the
  sibling shards and sums their tensor tables (metadata still comes from shard 1).
  Reading only the first shard would undercount weights and per-layer KV — for a
  4-shard model the tensor sum jumps from ~14.8 GiB to the full ~46 GiB,
  matching the `llama-fit-params` `model` column.
- **GGUF metadata** — architecture, block count, embedding length, head counts,
  context length, sliding window, vocabulary size.
- **Args** — parsed into resolved context params (`resolveContextParams`):
  `n_ctx`/`n_ctx_seq`/`n_batch`/`n_ubatch`/`n_seq_max`/`kv_unified`/`flash_attn`/
  cache types/`offload_kqv`/`n_gpu_layers`, matching `llama-server`'s defaults
  (parallel=4, kv_unified=true, ctx padded to 256, cache type f16).
- **Pools** — gpu/host pools from `config/resources.json`; placement maps each
  tensor and KV layer to a pool.

## Categories

- **Weights** — sum of per-tensor bytes, placed across pools by `-ngl`/`-ts`/
  `--cpu-moe`/`--n-cpu-moe` (input embedding stays on host; output follows the
  output layer). This is the **resident** footprint (mmap'd weights occupy
  page-cache RAM and must stay resident to run without thrashing) — see the
  calibration note below.
- **KV cache** — derived from the **tensor geometry**, not hparams: per KV-bearing
  layer, `n_embd_k_gqa` is read from `blk.N.attn_k.weight` dims and the cache
  bytes are `ggmlRowSizeBytes(cache_type, n_embd_k_gqa) * n_ctx_seq * n_stream`
  (likewise V). This is exact for GQA and correctly counts only the layers that
  actually have a KV cache (hybrid models). Verified to the MiB against
  `llama-fit-params` across dense models and cache types.
- **Sliding-window attention (SWA) + KV sharing** — for SWA architectures with
  distinct global/SWA head dims (e.g. Gemma 3n/`gemma4`), SWA layers (the smaller
  `attn_k` dim) are capped at the window instead of the full context:
  `tokens = min(n_ctx, n_seq_max * pad(sliding_window + n_ubatch, 256))`, and like
  the recurrent state they scale with `--parallel` (global layers stay on a single
  `n_ctx` stream under `kv_unified`). When `*.attention.shared_kv_layers` is set,
  the last `shared_kv_layers` layers reuse earlier layers' cache and allocate
  none, so only `block_count - shared_kv_layers` layers count. Reproduces the
  `llama-fit-params` `context` column to the MiB (verified on `gemma4` across
  context sizes, cache types, `--ubatch-size` and `--parallel`). SWA models
  **without** distinct dims (single-dim, scalar-period pattern — e.g. Gemma 2/3)
  are left at the full-context upper bound with a warning.
- **Recurrent state** — for hybrid/SSM architectures (e.g. Qwen3-Next/`qwen35`,
  Mamba), each recurrent layer holds a fixed-size state cache instead of a KV
  cache: `(n_embd_r + n_embd_s) * 4 bytes` per layer **per sequence**, where
  `n_embd_r = (d_conv-1)*(d_inner + 2*n_group*d_state)` (conv state) and
  `n_embd_s = d_state*d_inner` (SSM state), read from the `*.ssm.*` GGUF
  hyperparameters. Unlike attention KV under `kv_unified`, this scales linearly
  with `--parallel` (one copy per sequence). It is folded into the KV/context
  category and reproduces `llama-fit-params`' `context` column to the MiB across
  context sizes, cache types and parallelism (verified on `qwen35`). When the
  `*.ssm.*` hyperparameters are absent the state is left unmodeled and the
  estimate drops to `low` confidence.
- **Compute** — dominated by the logits projection, `n_vocab * n_ubatch * 4`
  (verified exact: linear in `n_ubatch`, independent of `n_ctx` and flash-attn),
  plus an `n_embd`-scaled activation term.
- **Multimodal projector (`--mmproj`)** — a vision/audio adapter is a separate
  GGUF (`clip` architecture) that `llama-server` loads alongside the model. Its
  weights (the per-tensor sum of the projector file, read via the shard-aware
  reader) are folded into the footprint: on the **GPU** by default, on the
  **host** when `--no-mmproj-offload` is set. The projector has no KV cache; the
  vision **compute** buffer at image-encode time is not modeled (flagged).
  `llama-fit-params` cannot anchor this — it rejects `--mmproj` — so it is
  analytical-only. Surfaced as `mmprojBytesTotal`.
- **Speculative draft model (`--spec-draft-model`/`-md`)** — a second resident
  model loaded for speculative decoding. It is estimated recursively by the **same
  engine** over the draft GGUF, with the draft-specific args remapped onto the
  standard keys (`--spec-draft-ngl`→`-ngl`, `--spec-draft-type-k/v`→cache types;
  context/parallel/batch shared with the target). Its weights + KV + compute are
  added to the per-pool draws and reported as `draftBytesTotal`. The draft compute
  is sized **exactly like the target's** (`n_vocab × n_ubatch × 4`): `llama-fit-params`
  shows the draft/MTP compute reservation scales with `n_ubatch`, not `--parallel`
  (the `n_outputs_max = n_parallel` cap in `tools/server/server-context.cpp` only
  shrinks the small final-logits output buffer, not the dominant `n_ubatch`-wide
  graph). **NextN/MTP heads** (e.g. `gemma4-assistant`, arch with no `attn_k`/`attn_v`
  tensors) **share the target's KV cache** (`ctx_other`/`LLAMA_CONTEXT_TYPE_MTP`),
  so they allocate no separate KV — the geometry reader already yields 0 because
  such a head has no `attn_k` tensors. Verified on the gemma-4-E2B MTP head (Q8_0,
  78 MiB weights): the server logs `llama_kv_cache: layer N: sharing with layer M`
  for every draft layer, confirming KV sharing. (An earlier change capped the draft
  logits at `--parallel`; it was reverted because it under-counts the draft compute
  for every target — see the host-RSS note in Calibration.)
- **Overhead** — a per-GPU CUDA-context margin (rough constant, flagged), added
  once per GPU pool that holds any bytes (so the draft/projector share the
  target's CUDA context, not a second one).

## Confidence and warnings

`MemoryEstimate.confidence` is `high` for plain dense/MoE transformers, `medium`
when sliding-window (SWA), GPU placement, or a modeled hybrid recurrent state is
involved, and `low` for MLA or recurrent/hybrid models whose state is **not**
modeled (missing `*.ssm.*` hyperparameters). Each approximation adds a
`warnings[]` entry (SWA KV is an upper bound; recurrent state included/omitted;
GPU placement is unvalidated).

## API

`POST /api/memory-estimate` (`apps/api/src/memory-estimate/`):

- body: `{ instanceId?, args? }` — load an existing instance's args, and/or pass
  preview args; preview args override.
- `200 { data: { modelPath, estimate } }` on success.
- `422 { error }` for routers (`--models-preset`), remote models
  (`--hf-repo`/`--model-url`), a missing model file, or an unknown instance.

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

### Open items (GPU machine + gold `llama_memory_breakdown_print` table)

1. **GPU CUDA-context overhead** — replace the rough per-GPU constant with a
   measured value.
2. **Compute residual** — the `n_embd`-scaled term under-predicts the fit
   `compute` column by ~10–13% (gemma fit ≈ `1.13 × n_vocab × n_ubatch`); refine
   from the gold breakdown.
3. **Measured engine** — to report real host RSS (vs the conservative projection),
   probe the actual instance: resident weights (repack + mmap reclaim), compute
   touched, base process overhead. Not derivable analytically.

**Closed (no GPU required — verified on the CPU box against `llama-fit-params`):**

- Hybrid recurrent state (RS) cache (`qwen35`/Qwen3-Next), modeled from the
  `*.ssm.*` hyperparameters; matches the `context` column to the MiB across
  context sizes, cache types and `--parallel`.
- SWA + KV-sharing cache (`gemma4`/Gemma 3n): SWA layers capped at the window,
  `shared_kv_layers` reused layers dropped; matches the `context` column to the
  MiB across context sizes, cache types, `--ubatch-size` and `--parallel`.

## Running the calibration harness

`scripts/memory-estimate-calibrate.mjs` runs the analytical engine and
`llama-fit-params` over a config matrix and prints a comparison table (and JSON
with `--out`). Build first (`pnpm build`), then:

```bash
# CPU box (analytical vs fit-params projection):
pnpm memory:calibrate --out tmp/calib-cpu.json

# GPU machine (adds GPU-offload configs; --gpus = device count):
pnpm memory:calibrate --gpus 1 --out tmp/calib-gpu.json
```

Flags: `--models <dir>` (default `runtime/models`), `--fit-params <path>`
(default the built companion), `--gpus N`, `--only <substr>`, `--out <file>`,
or pass explicit `*.gguf` paths. On the GPU machine, share back the JSON plus,
ideally, the gold `llama_memory_breakdown_print` table and per-pid RSS for a few
real runs so items 1–5 above can be closed.
