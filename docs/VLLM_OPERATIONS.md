# vLLM operations and release gate

Managed vLLM support is production-qualified for the pinned single-GPU CUDA
profile below. Provisioning, argument discovery, creation, supervision,
complete-process-tree accounting, proxy autostart, protocol translation,
queueing, adoption, and shutdown were exercised against a real GPU.

## Supported profile

| Component | Supported contract |
| --- | --- |
| Host | Linux x86-64 |
| Accelerator | NVIDIA CUDA GPU visible through NVML |
| Python | uv-managed CPython supported by the selected vLLM release |
| Package | exact vLLM version from official PyPI or a hash-pinned wheel |
| Catalog entrypoint | immutable environment `bin/vllm` |
| Model | Hugging Face id or readable local model path |
| Managed launch | `bin/vllm serve <model> ...` |
| Public API | arriero OpenAI surface and Anthropic bridge |
| Native panels | none; health, model discovery, logs, and process telemetry are authoritative |
| Memory | explicit per-GPU utilization estimate plus manual host reservation |
| Scheduling | `preemptible` by default |

The qualified result and provenance are in
`docs/qualification/vllm/0.26.0-2026-07-30.md`.

## Qualified host profile

| Component | Qualified value |
| --- | --- |
| Host | Ubuntu 24.04, 8 visible AMD EPYC 7402P cores, 32 GiB RAM |
| GPU | one NVIDIA RTX A5000 24 GiB, compute capability 8.6 |
| Environment | vLLM 0.26.0, CPython 3.12.13, PyTorch 2.11.0+cu130 |
| Model | Qwen3-4B BF16, pinned revision |
| Limits | 8,192 model tokens, 2 sequences, 4,096 batched tokens |
| GPU policy | tensor parallel 1, utilization 0.85, prefix caching |
| Result | direct/proxied OpenAI, Responses, Anthropic, streaming, queueing, autostart, adoption, and shutdown passed |

This machine is sufficient for that supported profile. It is not a
multi-GPU/tensor-parallel qualification host. A tensor-parallel release gate
needs at least two compatible NVIDIA GPUs visible to the same process; use
identical cards with adequate per-device VRAM and prefer a high-bandwidth
peer-to-peer interconnect. Large BF16 models also require enough aggregate VRAM
for weights, KV cache, activations, and headroom; the 24-GiB A5000 profile is
deliberately scoped to Qwen3-4B.

## Install and create

1. Open **Environments**, select **vLLM**, choose a supported Python, and
   install an exact official PyPI version or a hash-pinned wheel. Wait for
   `installed / usable`.
2. Run `scripts/qualify-vllm-host.sh <environment-bin-directory>
   <artifact-directory>` and retain the raw output outside git.
3. Create a vLLM instance from the generated catalog entry. Supply exactly one
   Hugging Face model id or local model path as the model positional.
4. Bind the intended devices with `CUDA_VISIBLE_DEVICES`, set
   `--tensor-parallel-size`, and set `--gpu-memory-utilization` explicitly.
   Run the memory estimate and reserve the resulting draw on every selected GPU.
   Declare host RAM manually.
5. Set a deliberate `--max-model-len`, `--max-num-seqs`, and
   `--max-num-batched-tokens`; upstream maxima are not a safe capacity plan.
6. Prefer `--generation-config vllm` when stable server defaults are required.
   Without it, a model repository may override generation parameters.
7. Resolve every preflight error, start the instance, and wait for both HTTP
   health and model discovery. The port normally remains closed through model
   loading, so logs are the only intermediate progress source.

For vLLM 0.26.0 on the qualified host, set
`VLLM_USE_FLASHINFER_SAMPLER=0`. This avoids FlashInfer sampler JIT compiler
coupling between the host toolkit and the wheel's CUDA runtime. Treat this as
part of the pinned profile, not as a global recommendation for unrelated vLLM
versions.

## Upgrade qualification

Repeat all gates when changing vLLM, PyTorch/CUDA, Python, GPU architecture,
model family, quantization, or tensor-parallel topology:

- capture OS, CPU, NVML, driver, package freeze, entrypoint hashes, live
  `serve --help=all`, and model revision/hash;
- confirm live help parses without fallback and contains every configured flag;
- run direct `/health`, `/v1/models`, Chat Completions, Responses, and streaming;
- run the same OpenAI endpoints through the proxy plus Anthropic Messages
  through the bridge;
- exceed `--max-num-seqs` and observe the expected active/queued boundary;
- stop while idle and during active generation, then verify the full process
  group, listener, and GPU allocation disappear;
- restart the manager around a running engine and confirm adoption;
- start from an unloaded proxy target and confirm the initiating request waits
  for autostart;
- compare declared GPU/host draws with measured descendant VRAM/RAM/swap;
- induce missing model, invalid argument, occupied port, insufficient
  reservation, and incompatible CUDA/backend failures;
- exercise production self-update drain if that deployment feature is enabled.

Commit only sanitized provenance, measurements, timelines, and conclusions.
Runtime environments, model weights, raw logs, and credentials remain outside
git.

## Troubleshooting

- **Environment is installed but CUDA is unavailable:** compare the driver,
  wheel/PyTorch CUDA runtime, GPU compute capability, and
  `torch.cuda.is_available()`. The host `nvcc` version alone does not describe
  the wheel runtime.
- **Startup fails in FlashInfer/CCCL compilation:** use the backend documented
  by the qualified profile or install a compiler/toolchain that exactly matches
  the selected PyTorch runtime. Do not combine arbitrary CUDA header/compiler
  versions.
- **Startup takes roughly a minute:** weight loading, torch compilation, KV
  cache allocation, and CUDA graph capture all occur before the HTTP listener
  is ready. Follow managed logs instead of polling the port aggressively.
- **Generation behavior changes after a model update:** add
  `--generation-config vllm` or explicitly configure the desired sampling
  defaults.
- **Health is ready but shows a capability notice:** Model Runner V2 in 0.26.0
  does not support `thinking_token_budget`. Disable V2 only when that optional
  request field is required.
- **Memory admission is wrong:** set `--gpu-memory-utilization` explicitly,
  rerun the estimator, reserve every GPU selected by CUDA/TP order, and keep a
  separate manual host draw. Utilization is per GPU, not divided by tensor
  parallel size.
- **A local model fails as a Hugging Face repo id:** use an existing readable
  absolute or explicit relative path. Preflight blocks missing explicit local
  paths before launch.
- **Proxy requests queue:** inspect `--max-num-seqs`, active/queued model status,
  target priority, reservations, and eviction policy.
- **Stop returns while work is active:** vLLM's default shutdown behavior can
  end the request with `finish_reason=abort`. The manager must still remove all
  descendants and release VRAM.
