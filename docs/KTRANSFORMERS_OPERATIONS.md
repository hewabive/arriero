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
KT memory estimates are not in this release profile. A host-built wheel may be
installed through the managed wheel source when its source revision, build
flags, and SHA-256 are recorded; a general source-build job is still deferred.

## Qualified host profile

The result and complete provenance are in
`docs/qualification/ktransformers/0.6.4-2026-07-30.md`.

| Component | Qualified value |
| --- | --- |
| Host | Ubuntu 24.04, AMD EPYC 7402P with 8 visible AVX2 cores and one NUMA node |
| GPU | NVIDIA RTX A5000 24 GiB, compute capability 8.6 |
| Packages | `kt-kernel==0.6.4` host build + `sglang-kt==0.6.4` with upstream RoPE fix `04653fa` |
| Python / Torch | 3.12.13 / 2.9.1 with CUDA 12.8 runtime |
| Model | `Qwen/Qwen3-30B-A3B` + official Q4_K_M GGUF |
| KT profile | LLAMAFILE, 8 CPU workers, 1 pool, 32 GPU experts, 2 deferred experts |
| SGLang profile | TP 1, concurrency 2, 8,192 scheduled tokens, CUDA graph batch 1/2, radix cache |
| Result | direct and proxied OpenAI/Responses/Anthropic semantics and concurrency passed |

Do not substitute the public wheels on this host:

- public `kt-kernel==0.6.4` selects an AVX2-named extension but `CPUInfer(1)`
  terminates with `SIGILL`;
- public `sglang-kt==0.6.4` omits upstream RoPE commit `04653fa` and returned
  semantically corrupted output despite HTTP 200.

The qualified local artifact hashes are:

```text
kt_kernel-0.6.4-cp312-cp312-linux_x86_64.whl
f96de0b5cb06a3059b6f7342080fbbf2b481e1bc06129e07b136039a45775c35

sglang_kt-0.6.4-py3-none-any.whl
7d9a32e236424b156060fd6ef82cc437948e7fa0e70916b831622bde08ab3365
```

## Install and create

1. Upgrade every enabled federation peer to a version whose
   `/api/federation/capabilities` includes `ktransformers` in both
   `instanceKinds` and `creatableInstanceKinds`. Do not create a federated
   KTransformers instance while an enabled peer lacks that capability.
2. Open **Environments**, choose **KTransformers (SGLang-KT)**, select Python
   3.11/3.12, and install either a separately qualified matched PyPI version or
   exactly one hashed wheel for each root package. On the RTX A5000 host use
   the two artifacts above. Wait for `installed / usable`; validation executes
   both imports, exact metadata checks, and `CPUInfer(1)`.
3. Create a KTransformers instance from the generated `sglang` catalog entry.
   Set the main model, CPU weights, method, optional served model name, CUDA
   visibility, and advanced SGLang/KT arguments.
4. Declare positive memory draws for host RAM and every GPU selected by
   `CUDA_VISIBLE_DEVICES` and `--tensor-parallel-size`. Strict KTransformers
   admission cannot be force-overridden.
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

## Troubleshooting

- **Environment installed but unavailable:** confirm Linux x86-64,
  an NVIDIA driver reported as available on **Environment prerequisites**, and
  Python 3.11/3.12. Availability and installation integrity are separate states.
- **Runtime imports failed:** rebuild the immutable environment. Both package
  metadata versions, imports, and freeze pins must match the environment spec.
- **`CPUInfer(1)` exits with `SIGILL`:** the wheel contains instructions newer
  than the CPU exposes even if its filename says AVX2. Use a wheel built for
  the exact host ISA; do not weaken the provisioning/preflight smoke test.
- **HTTP 200 but nonsensical tokens:** first validate the model independently,
  then verify that SGLang-KT contains upstream RoPE fix `04653fa`. Readiness is
  transport health, not a semantic qualification.
- **CPU method rejected:** select a method supported by host ISA or regenerate
  weights for the intended backend. AMX methods require AMX; RAWINT4 and
  LLAMAFILE require AVX2.
- **Reservation rejected:** reserve host RAM plus exactly the GPU pools selected
  in CUDA/TP order. Remove positive draws on hidden or unused GPUs.
- **NUMA rejected:** make node values distinct and online, match the thread-pool
  count, and remove manager interleave. Outer bind cannot span KT nodes.
- **Loading never becomes ready:** inspect raw logs and `/health`; log markers
  do not override HTTP health. Verify model and CPU-weight compatibility.
- **Memory exceeds declaration:** the details panel compares measured complete
  process-tree memory with declared reservations. Stop the instance and raise
  its draws before admitting competitors.
- **Healthy model remains degraded:** inspect swap and warnings. The qualified
  32-GiB host swapped roughly 2.8–3.4 GiB of the process tree during
  qualification, so degraded status is intentional. Do not hide it or disable
  admission checks.
- **Proxy requests queue:** check `--max-running-requests`, resource contention,
  target priority, and eviction policy. Under `idle-only`, active work drains
  instead of being interrupted.
