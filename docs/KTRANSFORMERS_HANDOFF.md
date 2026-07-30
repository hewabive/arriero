# KTransformers implementation handoff

This is the session-to-session state record for continuing KTransformers work
with Codex, including on a different NVIDIA host. It supplements the design
record and operator runbook; it does not replace either.

Snapshot date: 2026-07-30 (UTC).

Snapshot branch: `main`.

Qualification implementation tip before this handoff update: `b940dc1`
(`test(ktransformers): mirror module launcher layout`). The complete real-host
result is `docs/qualification/ktransformers/0.6.4-2026-07-30.md`.

## Read in this order

1. `docs/KTRANSFORMERS_HANDOFF.md` — current state and continuation procedure.
2. `docs/KTRANSFORMERS_SUPPORT.md` — accepted architecture, complete delivery
   plan, contracts, acceptance criteria, and implementation map.
3. `docs/KTRANSFORMERS_OPERATIONS.md` — supported profile, installation,
   qualification checklist, and troubleshooting.
4. `docs/ENGINE_ADAPTERS.md`, `docs/ENVIRONMENTS.md`, and
   `docs/RESOURCE_MANAGEMENT.md` — stable subsystem contracts implemented by
   the KTransformers work.

## Current delivery state

| Phase | State | Commit / evidence |
| --- | --- | --- |
| Plan | Complete | `284efec` — implementation plan and accepted decisions |
| 0 — real-hardware spike | Complete for the LLAMAFILE slice | RTX A5000 / AVX2 qualification, including negative public-wheel findings and independent GGUF validation |
| 1 — contracts | Complete | `1d7ed5a` — engine descriptor, typed config, scheduling, federation capabilities |
| 2 — environments | Complete | `9e164e5` — provisioner registry and matched transactional `kt-kernel` + `sglang-kt` environments |
| 3 — lifecycle | Complete against fixtures and real runtime | `2bfd830` plus the live stop/adoption result and `b940dc1` fixture correction |
| 4 — resource safety | Complete | `5e1fc7f` — strict hybrid reservations, CUDA/TP matching, NUMA validation, memory diagnostics |
| 5 — web flow | Complete | `e6143ec` — engine-aware environment and typed instance creation/editing |
| 6 — proxy | Complete | `e273643` — concurrency, model identity, eviction policy, capability gating |
| 7 — release qualification | Complete for the pinned LLAMAFILE profile | Exact 0.6.4 artifacts, model revisions, host matrix, proxy protocols, concurrency, shutdown, adoption, and memory evidence are committed |
| 8 — post-MVP projects | Not started | Intentionally remains after real-hardware MVP qualification; see the independent list in the design record |

The initial KTransformers debt is closed for the exact LLAMAFILE combination in
the qualification record. Do not generalize that verdict to public 0.6.4
wheels, native/converted methods, another CPU ISA, multi-GPU, or multi-NUMA
hosts without a new recorded qualification.

## Last verified state

At implementation tip `b940dc1`:

- `pnpm check` passed;
- `pnpm build` passed with only the existing Vite large-chunk warning;
- `pnpm --filter @arriero/api test` passed: 941 tests, 0 failures;
- the corrected detached process-tree fixture passed five consecutive runs;
- the live tuned server remained semantically healthy through manager reload
  and adoption.

Repeat the repository checks after syncing or changing runtime behavior. Do not
treat a package install, fake-server test, or green typecheck as a substitute
for the live qualification matrix.

## Transfer state

At `b940dc1` the local branch was 19 commits ahead of `origin/main`; this
handoff update is a later local commit. This is an observation, not a request to
publish. Before another machine continues, transfer the final `main` tip and
verify that `git rev-parse HEAD` matches it. Do not assume `origin/main`
contains the qualification work.

After any additional work on the current machine, update:

- snapshot date and implementation tip;
- phase table and open inputs;
- verification commands and counts;
- transfer state;
- any newly accepted architecture decision.

Commit that update as the last handoff commit before transfer.

## Accepted invariants to preserve

- `ktransformers` is a distinct static instance kind, not vLLM or a dynamic
  plugin.
- Managed environments install exact matching versions of `kt-kernel` and
  `sglang-kt` transactionally, verify local hashes, execute `CPUInfer(1)`, and
  expose `bin/sglang`.
- Main model, CPU weights, KT method, and optional served name live in typed
  `engineConfig`; their managed CLI spellings are rejected in raw `args`.
- The catalog entry is `bin/sglang`, but managed launch and help use its sibling
  `bin/python -m sglang.launch_server` with argparse token semantics. This
  avoids optional diffusion imports in the umbrella CLI.
- HTTP `/health == 200` is the sole readiness authority; 503 is loading.
- The complete descendant tree belongs to the instance for termination and
  RAM/VRAM/swap/NUMA telemetry.
- The first supported profile is Linux x86-64, NVIDIA CUDA, and CPython
  3.11/3.12. Unsupported combinations fail explicitly.
- A positive host draw and positive draws on exactly the CUDA/TP-selected GPUs
  are mandatory and strict admission cannot be force-overridden.
- KTransformers owns internal NUMA placement. Manager interleave is forbidden;
  optional outer bind must agree with all internal KT nodes.
- Default eviction is `idle-only`; active leases drain and are not interrupted.
- KTransformers exposes generic OpenAI/Anthropic forwarding but no llama-native
  model, slot, stream-resume, timing, capability, or embedded Web UI actions.
- Federation peers must advertise KTransformers support before federated
  creation is considered release-safe.

## Qualified GPU-host inputs

These values apply only to the committed LLAMAFILE result.

| Input | Current state |
| --- | --- |
| `kt-kernel` version and wheel/hash | 0.6.4 host build / `f96de0b5cb06a3059b6f7342080fbbf2b481e1bc06129e07b136039a45775c35` |
| `sglang-kt` matching version and wheel/hash | 0.6.4 plus upstream RoPE fix `04653fa` / `7d9a32e236424b156060fd6ef82cc437948e7fa0e70916b831622bde08ab3365` |
| Python / PyTorch | 3.12.13 / 2.9.1, bundled CUDA 12.8 |
| NVIDIA GPU | RTX A5000 24 GiB, compute capability 8.6, driver 595.71.05 |
| CPU / topology | AMD EPYC 7402P, 8 visible AVX2 cores, one visible NUMA node |
| Native/converted KT method | Not qualified on this host |
| LLAMAFILE model | Qwen3-30B-A3B plus official Q4_K_M GGUF; exact revisions and checksum are in the result |
| Declared RAM/VRAM reservations | 27 GiB host / 23 GiB GPU |

The original upstream planning baseline was KTransformers commit
`01fdfa609e731f0dc1c088e596ad189144a046bd` (reported version
`0.6.3.post1`) with SGLang-KT submodule commit
`1e098a77ba395dc1a5f2dcbdf57bdb188e84bcee`. This is a research baseline,
not a supported runtime. The final kernel source is official KTransformers
`v0.6.4` commit `a8062bfa7e1060ce5855b5f1ad6aa6b116678307`;
the SGLang artifact adds upstream commit `04653fa`.

## Destination-machine continuation procedure

1. Verify the intended Git tip and a clean worktree.
2. Install the repository toolchain with the lockfile, then run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm check
   pnpm build
   pnpm --filter @arriero/api test
   ```

3. Record the qualification inputs above in a new result document before
   installing or launching the engine.
4. Create the matched managed environment through arriero. Do not bypass
   the provisioner with an untagged executable for the primary qualification.
5. Run:

   ```bash
   scripts/qualify-ktransformers-host.sh \
     <managed-environment>/bin \
     <private-artifact-directory>
   ```

6. Follow every live item in `docs/KTRANSFORMERS_OPERATIONS.md`, including
   health timeline, process tree, idle/active shutdown, adoption, proxy
   protocols, concurrency, reservations, memory, swap, and NUMA.
7. Sanitize artifacts before adding them to Git. Remove tokens, private model
   locations, usernames, hostnames, IP addresses, and proprietary prompts.
8. Commit a qualification result that names the exact source tip, package
   pair, hashes, hardware/software matrix, commands, pass/fail status, known
   deviations, and artifact paths.
9. Amend the design/runbook if live behavior contradicts an assumption; do not
   weaken preflight or readiness merely to make the run pass.

Suggested committed result location:

```text
docs/qualification/ktransformers/
  <package-pair>-<yyyy-mm-dd>.md
  <package-pair>-<yyyy-mm-dd>/
    sanitized artifacts...
```

Keep raw logs and full hardware dumps outside the repository until they have
been reviewed and sanitized.

## Qualification result template

The first result document should contain:

- source commit and dirty/clean status;
- exact environment spec and `freeze.txt`;
- wheel filenames and SHA-256 values;
- OS, kernel, Python, CUDA, driver, GPU, CPU, ISA, NUMA, RAM, and swap;
- model/weight identifiers and checksums without private paths;
- launch snapshot with secrets removed;
- `/health` and `/v1/models` timeline;
- process tree and process-group/cgroup ownership before and after stop;
- direct and proxied OpenAI chat/Responses results, streaming and non-streaming;
- Anthropic bridge result;
- concurrency and idle-only drain observations;
- declared versus measured RAM/VRAM/swap/NUMA data;
- negative preflight/admission cases;
- manager restart/adoption and self-update observations;
- final verdict: qualified, qualified with documented restrictions, or failed.
