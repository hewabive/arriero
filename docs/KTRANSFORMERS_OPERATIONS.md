# KTransformers operations and release gate

KTransformers support is production-visible only for a pinned and recorded
SGLang-KT profile. Provisioning, creation, supervision, accounting, proxy
scheduling, and one real LLAMAFILE profile are qualified. Every other package
pair, CPU backend, or hardware topology must repeat the release gate below.

## Supported profile

| Component | Supported contract |
| --- | --- |
| OS / CPU | Linux x86-64 |
| Accelerator | NVIDIA CUDA, visible through NVML |
| Python | uv-managed CPython 3.11 or 3.12 |
| Packages | exact matching versions of `kt-kernel` and `sglang-kt`, with artifact hashes |
| Catalog entrypoint | environment `bin/sglang` |
| Managed launch | sibling `bin/python -m sglang.launch_server` |
| Model | Hugging Face id or existing local SGLang model directory |
| CPU weights | existing native/converted weights or LLAMAFILE/GGUF directory |
| Public API | arriero OpenAI surface and Anthropic bridge |
| Native panels | none; health, logs, process memory, and proxy traces are authoritative |
| Scheduling | explicit host + selected-GPU reservations; `idle-only` by default |

ROCm, managed downloads/conversion, dynamic weight replacement, and automatic
KT memory estimates are not in this release profile. Released wheels are the
install path; a host-built wheel may still be installed through the managed
wheel source when its source revision, build flags, and SHA-256 are recorded.
Building `kt-kernel`/`sglang-kt` from source inside arriero is not planned
(the initiative was closed after 0.7.0 shipped working public wheels), and
KTransformers has no entry in the source-repository registry.

## Qualified host profiles

Complete provenance lives in `docs/qualification/ktransformers/`:
`0.7.0-2026-08-18.md` is current; superseded records (0.6.x, restricted to
manually built wheels) live in git history only.

| Component | 0.7.0 qualified value |
| --- | --- |
| Host | Ubuntu 26.04, AMD EPYC 7402P with 8 visible AVX2 cores and one NUMA node |
| GPU | NVIDIA RTX 4090 24 GiB, compute capability 8.9 |
| Packages | **public PyPI wheels** `kt-kernel==0.7.0` + `sglang-kt==0.7.0`, hashes in the record |
| Python / Torch | 3.12.14 / 2.9.1 with CUDA 12.8 runtime |
| Model | `Qwen/Qwen3.5-35B-A3B-FP8` (native FP8 method, no separate GGUF) |
| KT profile | FP8, 8 CPU workers, 1 pool, 2 GPU experts per layer |
| Instance env | `SGLANG_DISABLE_CUDNN_CHECK=1` is mandatory (env pins cuDNN 9.10; the check demands 9.15 for a Conv3d-only PyTorch bug that text MoE inference does not exercise) |
| Result | direct and proxied OpenAI/Responses/Anthropic semantics, concurrency, adoption and shutdown passed; ~2.3 tok/s decode — functional, not fast |

Since `kt-kernel` 0.7.0 the public wheel is multi-variant (AMX, four AVX-512
tiers, AVX2) with runtime CPU dispatch, and its AVX2 build carries software
fallbacks for the FP8/BF16/RAWINT4/GPTQ/MXFP native methods
(`FP8_PERCHANNEL` stays AVX-512/AMX-only) — public wheels are the default
install path from 0.7.0 on. Pre-0.7.0 public wheels were unusable on this host
class; the specifics are in the superseded 0.6.x qualification records in git
history.

Known upstream defect in `sglang-kt` 0.7.0: `/v1/responses` rejects a plain
string `input` (`input_ids should be a list of lists`); use the structured
`input` array form.

## Install and create

1. Upgrade every enabled federation peer to a version whose
   `/api/federation/capabilities` includes `ktransformers` in both
   `instanceKinds` and `creatableInstanceKinds`. Do not create a federated
   KTransformers instance while an enabled peer lacks that capability.
2. Open **Environments**, choose **KTransformers (SGLang-KT)**, select Python
   3.11/3.12, and install a qualified matched PyPI version (0.7.0+: the public
   pair) or exactly one hashed wheel for each root package.
   Wait for `installed / usable`; validation executes both imports, exact
   metadata checks, and `CPUInfer(1)`.
3. Create a KTransformers instance from the generated `sglang` catalog entry.
   Set the main model, CPU weights, method, optional served model name, CUDA
   visibility, and advanced SGLang/KT arguments.
4. Declare positive memory draws for host RAM and every GPU selected by
   `CUDA_VISIBLE_DEVICES` and the tensor-parallel argument — SGLang spells it
   `--tp-size`, and `--tensor-parallel-size` / `--tp` are read as the same
   value. Strict KTransformers admission cannot be force-overridden.
5. For multiple KT CPU pools, set `--kt-threadpool-count` and the same number of
   distinct `--kt-numa-nodes`. Do not use manager interleave. An optional outer
   bind must agree with every internal KT node.
6. Resolve every preflight error, create, start, and wait for HTTP health 200.
   HTTP 503 means loading even if the log parser has seen a ready-looking line.

## Upgrade qualification

Run `scripts/qualify-ktransformers-host.sh <environment-bin-directory>
<artifact-directory>` first. Then execute all of these with one native or
converted KT method and, when supported, one LLAMAFILE model:

- capture the launch snapshot and
  `bin/python -m sglang.launch_server --help`;
- record `/health` and `/v1/models` from spawn through warmup;
- run chat completions and Responses, streaming and non-streaming, through the
  public OpenAI proxy and an Anthropic messages request through the bridge;
- exercise the configured `--max-running-requests` queue boundary;
- stop while idle and while a request is active, then confirm every descendant
  exits and no listener/process group remains;
- restart the manager while the engine is running and confirm adoption;
- compare declared draws with measured descendant RAM/VRAM/swap;
- verify NUMA placement for every KT thread pool;
- induce bad weight path, unsupported method/ISA, insufficient reservation,
  CUDA/TP mismatch, and occupied port failures;
- run self-update drain and confirm an `idle-only` instance is not evicted with
  an active lease.

Commit sanitized timelines, logs, process trees, package freeze, and measured
memory/NUMA results with the qualified package pair. A fake-server pass is not
a substitute for this gate.

## Design decisions behind the profile

Rationale that is not derivable from the code or from `docs/ENGINE_ADAPTERS.md`:

- **The argument catalog reads the module, not the umbrella CLI.**
  `sglang serve --help` builds both the language-server and the diffusion-server
  help; a `sglang-kt` wheel without the diffusion-only dependencies prints the
  complete language-server help and *then* exits non-zero, which the catalog
  importer cannot distinguish from a real failure. `bin/python -m
  sglang.launch_server --help` is the same argparse surface without the
  unrelated import, so it exits cleanly
  (`arguments/catalog.ts:sglangLanguageServerHelpInvocation`; the umbrella entry
  in `HELP_INVOCATIONS` remains the fallback when the sibling interpreter is
  absent).
- **`--api-key` is blocked, not merely discouraged.** The supported topology is
  `client → authenticated arriero → loopback unauthenticated SGLang-KT`. Managed
  probes and endpoint-catalog rows carry no managed-upstream secret, so
  accepting the flag would produce an instance the manager cannot probe.
  Supporting it later needs a secret reference, auth headers on probes and
  forwarding, redaction, and federation rules. A non-loopback `--host` is
  warned about for the same reason.
- **Stopped-instance model identity** resolves as typed `servedModelName` →
  typed `model` verbatim (`org/model` is never basenamed) → no implied model. A
  running instance's `/v1/models` may enrich the catalog, but a mismatch with
  the configured served name is a diagnostic warning: it never silently renames
  a public proxy model.
- **`idle-only` eviction is a floor, not a preference.** A KTransformers target
  is evictable only when its runtime state is ready, `activeRequests` is zero,
  no lease holder is running, and drain has reached its safe stop point. A
  higher-priority competitor does not override it — cold start here is
  expensive and there is no KV/stream restore to soften an interrupt.
- **One instance owns one model bundle.** No weight-update endpoint and no
  multi-model router participate in the lifecycle; changing a model means
  editing configuration and restarting.

## Troubleshooting

- **Environment installed but unavailable:** confirm Linux x86-64,
  an NVIDIA driver reported as available on **Environment prerequisites**, and
  Python 3.11/3.12. Availability and installation integrity are separate states.
- **Runtime imports failed:** rebuild the immutable environment. Both package
  metadata versions, imports, and freeze pins must match the environment spec.
- **`CPUInfer(1)` exits with `SIGILL`:** the wheel contains instructions newer
  than the CPU exposes. Use the public multi-variant wheel (0.7.0+) or a wheel
  built for the exact host ISA; do not weaken the provisioning/preflight smoke
  test.
- **CPU method rejected:** select a method supported by host ISA or regenerate
  weights for the intended backend. AMX methods require AMX;
  `FP8_PERCHANNEL` requires AVX-512; RAWINT4, FP8, BF16 and LLAMAFILE run on
  AVX2.
- **Instance exits immediately citing cuDNN 9.15:** sglang-kt 0.7.0 gates
  startup on cuDNN ≥ 9.15 under PyTorch 2.9.1 (pytorch/pytorch#168167, a
  `nn.Conv3d`-only bug). Environments are immutable and pin cuDNN 9.10 — set
  instance env `SGLANG_DISABLE_CUDNN_CHECK=1`; text MoE inference does not
  use Conv3d.
- **Reservation rejected:** reserve host RAM plus exactly the GPU pools selected
  in CUDA/TP order. Remove positive draws on hidden or unused GPUs.
- **NUMA rejected:** make node values distinct and online, match the thread-pool
  count, and remove manager interleave. Outer bind cannot span KT nodes.
- **Loading never becomes ready:** inspect raw logs and `/health`; log markers
  do not override HTTP health. Verify model and CPU-weight compatibility.
- **Memory exceeds declaration:** the details panel compares measured complete
  process-tree memory with declared reservations. Stop the instance and raise
  its draws before admitting competitors.
- **Healthy model remains degraded:** inspect swap and warnings. A RAM-tight KT
  host swapping part of the process tree is degraded by design. Do not hide it
  or disable admission checks.
- **Proxy requests queue:** check `--max-running-requests`, resource contention,
  target priority, and eviction policy. Under `idle-only`, active work drains
  instead of being interrupted.
