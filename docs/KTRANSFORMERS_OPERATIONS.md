# KTransformers operations and release gate

KTransformers support is production-visible only for the pinned SGLang-KT
profile described here. The implementation is complete through provisioning,
creation, supervision, accounting, and proxy scheduling; real-engine release
qualification must still be executed on a supported GPU host for every new
package pair.

## Supported profile

| Component | Supported contract |
| --- | --- |
| OS / CPU | Linux x86-64 |
| Accelerator | NVIDIA CUDA, visible through `nvidia-smi` |
| Python | uv-managed CPython 3.11 or 3.12 |
| Packages | exact matching versions of `kt-kernel` and `sglang-kt` |
| Entrypoint | environment `bin/sglang serve` |
| Model | Hugging Face id or existing local SGLang model directory |
| CPU weights | existing native/converted weights or LLAMAFILE/GGUF directory |
| Public API | arriero OpenAI surface and Anthropic bridge |
| Native panels | none; health, logs, process memory, and proxy traces are authoritative |
| Scheduling | explicit host + selected-GPU reservations; `idle-only` by default |

Source builds, ROCm, managed downloads/conversion, dynamic weight replacement,
and automatic KT memory estimates are not in this release profile.

## Install and create

1. Upgrade every enabled federation peer to a version whose
   `/api/federation/capabilities` includes `ktransformers` in both
   `instanceKinds` and `creatableInstanceKinds`. Do not create a federated
   KTransformers instance while an enabled peer lacks that capability.
2. Open **Environments**, choose **KTransformers (SGLang-KT)**, select Python
   3.11/3.12, and install either the matched PyPI version or exactly one wheel
   for each root package. Wait for `installed / usable`.
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

- capture launch snapshot and `sglang serve --help`;
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
  `nvidia-smi`, and Python 3.11/3.12. Availability and installation integrity
  are separate states.
- **Runtime imports failed:** rebuild the immutable environment. Both package
  metadata versions, imports, and freeze pins must match the environment spec.
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
- **Proxy requests queue:** check `--max-running-requests`, resource contention,
  target priority, and eviction policy. Under `idle-only`, active work drains
  instead of being interrupted.

