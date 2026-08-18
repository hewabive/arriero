# SGLang operations

Managed upstream-SGLang support is implemented end to end — provisioning,
argument discovery, creation, preflight, supervision, complete-process-tree
accounting, proxy serving, adoption, and shutdown — but has **no recorded
real-host qualification yet**. Treat every profile as unqualified until a
record lands under `docs/qualification/sglang/`; the KTransformers gate
(`docs/qualification/ktransformers/`) covers the SGLang-KT fork, not this
engine.

## Supported contract

| Component | Supported contract |
| --- | --- |
| Host | Linux with an NVIDIA CUDA GPU visible through NVML |
| Python | uv-managed CPython supported by the selected SGLang release |
| Package | exact upstream `sglang` version from PyPI (extras default `all`) or a hash-pinned wheel |
| Catalog entrypoint | immutable environment `bin/sglang`, catalog tag `sglang` |
| Managed launch | sibling `bin/python -m sglang.launch_server ...` (same module invocation as SGLang-KT) |
| Model | `--model-path` with a Hugging Face id or readable local path; the instance form's Model field owns this argument |
| Public API | arriero OpenAI surface and Anthropic bridge; no native panels |
| Memory | no analytical estimator — declare draws manually or capture a measured baseline |
| Scheduling | `preemptible` by default; memory admission `confirmable` |

## Relationship to KTransformers (SGLang-KT)

The two kinds share the runtime plumbing that is SGLang-shaped rather than
fork-shaped: the `argparse-flags` argv builder, the `sglang` log parser, the
`sglang-help` catalog parser (per-binary runtime `--help`, so fork/upstream
argument drift is handled per instance), the max-running-requests concurrency
parser, the 15 s HTTP probe timeout, and the shared preflight checks in
`process/preflight-sglang.ts` (CUDA/TP, argument compatibility, loopback
managed boundary, serving warnings). Everything kt-kernel-specific stays in
`preflight-ktransformers.ts` and the KT typed `engineConfig`.

Both kinds read the same `engines.sglang` section of
`config/argument-defaults.json` (deliberate — the mapping key is the catalog
parser id) and the same upstream-tracking reference docs at `#/args/sglang`
(`content/engine-args/sglang/`, snapshot pinned to the newest upstream stable
tag). Fork-only flags are documented there as "Расхождение с форком" notes.

## Install and create

1. Open **Environments**, select **SGLang**, choose a Python, and install an
   exact upstream PyPI version (extras `all`) or a hash-pinned wheel. Wait for
   `installed / usable`.
2. Create an sglang instance from the generated catalog entry. Set the Model
   field to a Hugging Face id or local path — it serializes as `--model-path`.
3. Bind devices with `CUDA_VISIBLE_DEVICES` and `--tp-size`; set
   `--mem-fraction-static` explicitly (preflight warns when it is unset) and
   `--max-running-requests` as the concurrency boundary the proxy plans
   against.
4. Declare GPU and host memory draws manually; once the instance runs, capture
   a measured baseline and apply it as draws.
5. Managed instances bind loopback only and must not set `--api-key`
   (authentication terminates at arriero); both are preflight errors.
6. Cold start is slow: weight loading, warmup, and CUDA graph capture happen
   before the HTTP listener answers. Follow managed logs; probes use a 15 s
   timeout.

## Qualification checklist (for the first release gate)

Mirror the vLLM/KTransformers gates: record host/driver/environment/model
provenance; verify live `--help` parses without the fallback catalog and
contains every configured flag; run direct and proxied OpenAI + Anthropic
bridge requests including streaming; exceed `--max-running-requests` and
observe queueing; stop while idle and mid-generation and verify the whole
process group, listener, and GPU allocation disappear; restart the manager
around a running engine and confirm adoption; compare declared draws with
measured descendant VRAM/RAM; induce the standard preflight faults. Commit
only sanitized provenance under `docs/qualification/sglang/`.
