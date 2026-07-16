# KTransformers support plan

Status: implementation in progress.

Implemented on `main`:

- Phase 1 — engine contracts, typed configuration, argparse argv semantics,
  scheduling defaults, and federation capability advertisement;
- Phase 2 — provisioner registry, matched `kt-kernel` + `sglang-kt`
  environments, validation, availability, and catalog ownership;
- Phase 3 — typed launch compilation, strict runtime preflight, SGLang help and
  log adapters, HTTP-authoritative readiness, all-descendant telemetry policy,
  process-group shutdown, and restart adoption coverage;
- Phase 4 — mandatory hybrid reservations, strict non-overridable admission,
  CUDA/TP pool matching, internal NUMA validation, hybrid placement reporting,
  and declared-versus-measured memory diagnostics;
- Phase 5 — engine-aware environment installation, typed KTransformers instance
  creation/editing, shared preview/submit serialization, reservation and NUMA
  guidance, scheduling policy controls, and production form enablement.

Phase 0 and real-engine parts of Phase 7 remain pending a supported Linux
x86-64 NVIDIA host. Product phases 6 onward remain incomplete.

This document is the implementation plan for managed KTransformers support in
llama-manager. It records the architecture decisions accepted on 2026-07-16,
the target contracts, the delivery phases, migrations, tests, and acceptance
criteria. As phases land, stable engine and environment contracts move into
`docs/ENGINE_ADAPTERS.md`, `docs/ENVIRONMENTS.md`, and the relevant operational
documents; this file remains the delivery record.

## Upstream baseline and scope

The supported product is current KTransformers, not the archived standalone
`ktransformers/server/main.py` runtime.

Upstream baseline inspected for this plan:

- KTransformers commit `01fdfa609e731f0dc1c088e596ad189144a046bd`
  (2026-07-15), reporting version `0.6.3.post1` in `version.py`;
- SGLang-KT submodule commit `1e098a77ba395dc1a5f2dcbdf57bdb188e84bcee`;
- serving stack: `kt-kernel` + the `sglang-kt` fork;
- launch surface: `sglang serve ...` (equivalent to
  `python -m sglang.launch_server ...`);
- health/model surface: `GET /health` and `GET /v1/models`;
- public inference surface: OpenAI-compatible chat completions, completions,
  embeddings where supported by the model, and Responses;
- model inputs: an SGLang/Hugging Face model (`--model`) plus CPU-side expert
  weights (`--kt-weight-path`), which may be native weights, converted AMX
  weights, or a GGUF directory for the LLAMAFILE backend.

The first product profile deliberately supports only:

- Linux x86-64;
- NVIDIA CUDA visible through `nvidia-smi`;
- uv-managed CPython 3.11 or 3.12;
- official, version-matched `kt-kernel` and `sglang-kt` wheels;
- one model bundle per managed process;
- OpenAI-compatible serving through the llama-manager proxy;
- explicit RAM and GPU reservations before start.

ROCm, source builds, non-x86 platforms, automatic model downloads, weight
conversion, and dynamic in-process model replacement are deferred. A manually
built compatible environment remains usable through a tagged Path Catalog
entry, but it is not a managed environment in the first release.

## Accepted architecture decisions

The following decisions are final for this implementation.

1. **KTransformers is its own instance kind.** The public kind is
   `"ktransformers"`, with display name `KTransformers (SGLang-KT)`. It is not
   modeled as vLLM and not exposed as generic SGLang. Internal SGLang adapters
   use reusable ids so a future plain `sglang` kind can share them.
2. **Runtime and provisioning contracts stay separate.** The pure core
   `EngineDescriptor` describes launch, probes, capabilities, process topology,
   resource behavior, and form behavior. An API-side environment provisioner
   describes packages, entrypoints, validation, and platform availability.
3. **A managed environment pins a matched package pair.** The portable desired
   state pins `kt-kernel == X` and `sglang-kt == X`, plus Python and install
   source. The `ktransformers` meta-package is not the version authority.
4. **Required model fields are typed.** Main model, CPU weights, KT method, and
   optional served model name have one canonical typed representation. Raw
   `args` remain an advanced escape hatch but cannot duplicate those managed
   keys.
5. **One instance owns one model bundle.** No SGLang weight-update endpoint or
   multi-model router participates in the first lifecycle contract. Changing a
   model means changing configuration and restarting the instance.
6. **SGLang uses argparse token semantics.** Array values expand as separate
   argv tokens. Launch never depends on a live help catalog.
7. **The complete process tree belongs to the instance.** SGLang scheduler,
   detokenizer, resource tracker, tensor-parallel workers, and KT workers are
   included in RAM, VRAM, swap, NUMA, shutdown, and ownership accounting.
8. **HTTP health is authoritative.** Only `GET /health == 200` means ready;
   `503` means loading. Log markers report progress and errors but cannot make an
   unhealthy process ready.
9. **KTransformers owns internal NUMA placement.** `--kt-threadpool-count` and
   `--kt-numa-nodes` control KT thread pools. llama-manager owns admission and
   outer isolation and does not add interleave placement by default.
10. **Reservations drive admission.** The first release requires declared host
    and GPU memory draws. Runtime measurements detect drift and overuse but do
    not replace pre-start reservations.
11. **Default eviction is idle-only.** Active KTransformers requests are never
    force-evicted by default. The process may be stopped only after its request
    count drains to zero. Cold-start cost becomes a later scheduler input.
12. **Concurrency is engine-derived.** KTransformers request admission reads
    SGLang `--max-running-requests`; no new `kind ===` branch is added to the
    proxy path.
13. **The manager owns the public auth boundary.** The managed server binds to
    loopback and does not use `--api-key` in the first release. Public auth and
    TLS terminate at llama-manager or its front proxy.
14. **The initial support matrix is narrow and explicit.** Unsupported
    accelerator, Python, platform, wheel, and CPU-instruction combinations fail
    preflight or report the environment unavailable instead of attempting a
    best-effort launch.
15. **Launch profiles are not llama presets.** Future KTransformers tuning
    profiles are versioned engine launch profiles, not llama-server
    `--models-preset` INI files.
16. **Federation tolerates unknown engines.** Local persisted schemas remain
    strict. Remote wire parsing and capability negotiation must not fail an
    entire node catalog because a peer reports an unknown engine kind.
17. **SGLang-native diagnostics are deferred.** The initial descriptor uses
    `nativeApi: "none"`; generic health, models, logs, and memory are sufficient
    for MVP.
18. **No dynamic engine plugin system is introduced.** Static exhaustive
    registries remain intentional. This work removes hardcoded kind comparisons
    without making schemas or UI extensions dynamically loadable.

## Target architecture

```text
Environment spec
  engine = ktransformers
  version + Python + install source
          |
          v
KTransformers environment provisioner
  installs kt-kernel==X + sglang-kt==X
  validates imports, versions, platform, bin/sglang
          |
          v
Path Catalog binary (engineKind=ktransformers)
          |
          v
Managed instance
  typed KTransformers config
  advanced args + env + reservations + scheduling policy
          |
          v
sglang serve --model ... --kt-weight-path ... --kt-method ...
          |
          +--> /health and /v1/models
          +--> OpenAI-compatible API
          +--> complete descendant process tree telemetry
          |
          v
llama-manager proxy
  lease + concurrency admission + idle-only eviction
```

The generic process supervisor remains the process owner. The KTransformers
adapter supplies engine-specific translation and interpretation; it does not
fork a second supervisor or bypass launch snapshots.

## Core contracts

### Instance kind and descriptor

Add `"ktransformers"` to `INSTANCE_KINDS`. It is initially present with
`form.creatable: true` after environment, form,
preflight, and lifecycle phases are complete.

Target descriptor:

| Field | KTransformers value |
| --- | --- |
| `displayName` | `KTransformers (SGLang-KT)` |
| HTTP | host `127.0.0.1`, port `30000`, keys `--host` / `--port` |
| Proxy | `serveEndpoint:true`, `requestLease:true`, all llama-native capabilities `false` |
| Probe | `openai-http`, authoritative HTTP health |
| Native API | `none` |
| Launch prefix | `serve` |
| Argv builder | `argparse-flags` |
| Preflight | `ktransformers` |
| Argument catalog | `sglang-help` |
| Log parser | `sglang` |
| Estimator | `none` initially, `sglang-kt-reservation` later |
| Resource profile | `ktransformers-hybrid` |
| Process tree | `all-descendants` |
| Default eviction | `idle-only` |
| Concurrency parser | `sglang-max-running-requests` |

Extend the descriptor with pure-data ids rather than functions:

```ts
type EngineProcessTreePolicy =
  | "root-only"
  | "named-descendants"
  | "all-descendants";

type EngineConcurrencyId =
  | "none"
  | "llama-parallel"
  | "vllm-sequences"
  | "sglang-max-running-requests";

type EngineEvictionPolicy = "never" | "idle-only" | "preemptible";
```

The precise nesting may follow the existing descriptor style, but process-tree,
concurrency, and default eviction semantics must be declared exactly once and
consumed through exhaustive registries.

### Typed KTransformers instance configuration

Add an optional engine-specific configuration union to instance create,
preview, stored config, response, and update schemas. The initial member is:

```ts
type KTransformersInstanceConfig = {
  type: "ktransformers";
  model: string;
  cpuWeights: string;
  method:
    | "AMXINT4"
    | "AMXINT8"
    | "RAWINT4"
    | "FP8"
    | "FP8_PERCHANNEL"
    | "BF16"
    | "LLAMAFILE";
  servedModelName?: string;
};
```

The schema must validate that `instance.kind` and configuration `type` match.
For KTransformers, the following raw keys are reserved and rejected if present
in `args`:

- `--model` and `--model-path`;
- `--kt-weight-path`;
- `--kt-method`;
- `--served-model-name`.

The launch compiler emits those flags from the typed configuration, then adds
advanced args. This prevents UI values and raw args from silently disagreeing.

Existing llama-server, rpc-worker, and vLLM records require no immediate data
migration. The union is optional for their kinds. A later cleanup may migrate
vLLM's positional model into the same pattern, but KTransformers delivery does
not depend on it.

### Argv construction

Add `argparse-flags` alongside `flag-map`:

- fixed prefix first (`serve`);
- any explicit positional arguments next (none for managed KTransformers);
- flags emitted in deterministic key order;
- `true` emits only the key;
- false/null/undefined emits nothing;
- scalar emits `key value`;
- array emits `key value1 value2 ...`;
- CSV/JSON arguments are stored as strings and remain one token.

Launch snapshots store the final argv exactly as today, so adoption and drift
detection include typed configuration and list-token changes.

### Scheduling policy

Add persisted instance scheduling configuration:

```ts
type InstanceSchedulingPolicy = {
  evictionPolicy?: "never" | "idle-only" | "preemptible";
};
```

Creation resolves an omitted value from the engine descriptor and persists the
resolved result. Persisting the result avoids changing existing instances when
a future release changes an engine default.

Scheduler rules:

- `never`: the target cannot be selected for eviction;
- `idle-only`: it may be evicted only when `activeRequests === 0` and no live
  lease holder exists;
- `preemptible`: current scheduler/resumable behavior is allowed, subject to
  engine capabilities.

The KTransformers form defaults to `idle-only`. Changing it to `preemptible` is
an advanced, explicit action and must explain that no native KV/stream restore
exists.

## Environment provisioning contract

### Provisioner registry

Refactor the current vLLM-specific environment code into an API-side exhaustive
registry keyed by managed environment engine:

```ts
type EnvironmentProvisioner = {
  displayName: string;
  requirements(spec): string[];
  entrypoint(spec): string;
  validationCommand(spec, finalDir): string[];
  validateLayout(spec, finalDir): string | null;
  availability(spec, system): EnvironmentAvailability;
  catalogName(spec): string;
};
```

Keep orchestration generic:

1. Python preflight/install;
2. relocatable staging venv creation;
3. install every resolved root requirement in one uv transaction;
4. freeze;
5. validate staging entrypoint;
6. atomic finalize;
7. validate imports and exact versions from the final path;
8. reconcile the tagged Path Catalog entry.

KTransformers provisioner behavior:

- PyPI roots: `kt-kernel==X` and `sglang-kt==X`;
- entrypoint: `bin/sglang`;
- validation imports: `kt_kernel` and `sglang`;
- metadata validation: both distributions report exactly `X`;
- freeze validation: both exact pins exist;
- catalog tag: `engineKind: "ktransformers"`;
- catalog display: `KTransformers X [id-prefix]`.

The environment remains immutable and rebuildable desired state. No venv is
activated, and no in-place package upgrade is allowed.

### Install sources and migration

The current environment source supports a single PyPI requirement or one wheel
URL. KTransformers needs two coordinated root distributions. Introduce an
engine-specific source union without invalidating existing vLLM specs:

```ts
type KTransformersInstallSource =
  | {
      kind: "pypi";
      indexUrl: string | null;
    }
  | {
      kind: "wheels";
      artifacts: Array<{
        distribution: "kt-kernel" | "sglang-kt";
        url: string;
        sha256: string | null;
      }>;
      dependencyIndexUrl: string | null;
      torchBackend: string | null;
    };
```

Rules:

- exactly one root artifact per required distribution;
- HTTPS or file URLs only;
- credentials forbidden in stored URLs;
- optional SHA-256 is appended to the uv requirement URL;
- private credentials come from the manager environment;
- dependency resolution still writes `freeze.txt`; exact transitive
  reproducibility remains out of scope until a lockfile domain is introduced.

Existing `engine:"vllm"` specs keep their current source shape and parse
unchanged. Repository reads normalize legacy rows in memory only; no mass
rewrite is required.

### Availability and platform validation

An installed KTransformers environment is `usable` only when all first-profile
requirements hold:

- platform is Linux x86-64;
- configured Python is 3.11 or 3.12;
- at least one NVIDIA accelerator is visible;
- environment layout and exact package pins validate;
- the selected package source supplies wheels compatible with the node.

CPU method compatibility is instance-specific and belongs in instance
preflight, not environment availability. The same environment may serve
LLAMAFILE on AVX2 and AMXINT8 on an AMX node.

## Process and runtime behavior

### Process ownership and telemetry

Replace the vLLM-specific descendant condition with descriptor-driven policy.

Ownership resolution order:

1. cgroup membership when the instance has a manager-owned cgroup;
2. supervised root PID and its process-group descendants;
3. process table descendant closure from the supervised root PID;
4. llama-only router port/name recovery for the existing llama router policy.

For `all-descendants`, no command-name filter is applied after descendant
membership is established. Ownership is still restricted to the current user.

The resulting PID set feeds:

- `/proc` RSS/anonymous/file-backed memory;
- swap totals;
- `nvidia-smi` per-process VRAM;
- NUMA placement;
- instance memory layout;
- shutdown verification.

Acceptance requires demonstrating that scheduler, detokenizer, resource
tracker, and model workers all appear in the instance layout and that no child
survives a normal stop.

### Health and logs

Reuse `openai-http` probing. For a running KTransformers process:

- connection failure: starting/loading unless terminal log evidence exists;
- `/health` 503: loading;
- `/health` 200: ready, subject to general degraded checks;
- `/v1/models` supplies live model identity and diagnostics;
- `/v1/models` failure with healthy `/health` is degraded, not unready.

Add an SGLang log parser with fixtures from a real KTransformers launch. It
recognizes at least:

- server process startup;
- model/tokenizer configuration;
- `Load weight begin` / `Load weight end`;
- KT CPU backend and expert placement initialization;
- KV-cache allocation;
- warmup;
- `The server is fired up and ready to roll!`;
- Python tracebacks, worker exits, CUDA OOM, host allocation failure, and KT
  kernel initialization failures.

Suggested progress phases:

| Evidence | Phase | Percent policy |
| --- | --- | --- |
| process spawned | `starting` | 5 |
| configuration/tokenizer | `metadata` | indeterminate |
| weights loading | `tensors` | parsed percent when present, otherwise indeterminate |
| KT workers / cache | `context` | indeterminate |
| warmup | `warmup` | 95 |
| health 200 | `ready` | 100 |

The log parser may report its ready marker, but `deriveStatus` must continue to
prefer HTTP health. User-facing status strings must use the descriptor display
name for KTransformers while preserving documented legacy strings for existing
kinds.

## Preflight contract

Add `preflight-ktransformers.ts` and register it under the descriptor id.
Preflight is deterministic and does not import the model or allocate GPU/RAM.

### Blocking checks

1. The selected binary entry is tagged `ktransformers` and resolves to an
   executable `bin/sglang`.
2. Typed KTransformers configuration exists and matches the instance kind.
3. Main model is non-empty. A local value must exist and be a directory; a
   syntactically valid HF repository id is allowed for remote resolution.
4. CPU weights exist locally. The initial release does not auto-download them.
   Accept a directory; allow a single GGUF path only if upstream proves it is
   accepted for the selected version, otherwise require the containing
   directory.
5. `method` is supported by the current manager version.
6. Reserved managed keys do not appear in advanced args.
7. `--api-key` is absent.
8. At least one NVIDIA GPU is visible after `CUDA_VISIBLE_DEVICES`.
9. Tensor-parallel size is positive and no greater than visible GPU count.
10. A positive host-memory reservation exists.
11. A positive reservation exists for every selected GPU pool.
12. Capacity admission succeeds or the existing force-start confirmation path
    is used according to global policy.
13. `--kt-cpuinfer`, when set, is positive and does not exceed detected
    physical cores available to the instance.
14. `--kt-threadpool-count` is positive.
15. When `--kt-numa-nodes` is present, its expanded value count equals
    `--kt-threadpool-count`, every node exists, and values are unique.
16. Manager NUMA interleave is rejected for KTransformers in the first release.
17. Manager single-node bind is rejected when KT configuration names multiple
    NUMA nodes.
18. Method-specific CPU features are present according to a versioned support
    table (for example AMX methods require the relevant AMX features; LLAMAFILE
    requires the supported AVX baseline).
19. At least one of `--kt-num-gpu-experts` or
    `--kt-gpu-experts-ratio` is configured, and their values are valid; if both
    are supplied, the upstream precedence rule is shown explicitly.

### Warnings

- main model and CPU weights resolve to the same directory;
- remote main model means startup may download data and cold-start time is
  unbounded;
- no explicit `--mem-fraction-static` is set, so SGLang chooses it at runtime;
- `--kt-cpuinfer` differs substantially from detected physical core count;
- thread-pool count differs from selected NUMA-node count;
- swap is enabled or current host free memory is already below the declared
  reservation;
- advanced source/build combinations are manually cataloged and not validated
  as a managed environment.

Error and warning wording must identify the affected form field or raw argument
key so preview preflight is actionable in the UI.

## Resource management and NUMA

### Initial resource profile

Add `ktransformers-hybrid` resource derivation:

- placement is always `hybrid` for the supported serving profile;
- `usesHost` is true;
- selected GPU pools come from `CUDA_VISIBLE_DEVICES` and SGLang tensor
  parallel size;
- declared draws override inferred pool selection exactly as today;
- signals include KT method, CPU thread count, thread-pool count, selected NUMA
  nodes, GPU expert count/ratio, tensor parallelism, and source (`args` or
  declared draws).

Manual reservations are not optional UI decoration. The form blocks create and
start until host and required GPU rows exist. A user may enter them manually or
apply a future estimate.

### NUMA ownership

The KTransformers instance form exposes KT NUMA arguments in its engine section
and explains their relationship:

- `kt-threadpool-count`: number of KT CPU pools;
- `kt-numa-nodes`: explicit node assigned to each pool;
- manager NUMA policy: outer isolation only.

The generic manager NUMA panel is hidden or restricted for the initial profile.
No implicit translation between manager interleave and KT arguments is made.

Deferred resource work:

- multi-node cpuset isolation;
- per-NUMA-node capacity pools and reservations;
- automatic distribution of host reservation across KT nodes;
- measured high-water feedback and calibration;
- swap avoidance policy stronger than a degraded-health warning.

### Later estimator

`sglang-kt-reservation` is a later phase and must not block MVP. Its first safe
version should estimate only when inputs are explicit and local:

- GPU reservation per selected GPU = explicit `--mem-fraction-static` times
  that GPU pool capacity; do not invent the SGLang hardware-dependent default;
- host weights = local CPU-weight artifact size plus a conservative calibrated
  overhead;
- remote model or missing explicit fraction returns `not applicable`, not a
  guessed high-confidence result;
- confidence and warnings state which portions are measured from files and
  which are conservative factors.

## Proxy and scheduler integration

### Capabilities and forwarding

KTransformers uses the existing generic OpenAI-compatible forwarder. Descriptor
capabilities are:

```text
serveEndpoint  = true
requestLease   = true
modelLoadUnload = false
slotSave       = false
streamResume   = false
sseTimings     = false
```

Consequences:

- a stopped target is started, not sent llama load verbs;
- an unloaded target requires process restart;
- no llama `return_progress` injection or SSE timing assumptions;
- standard streaming, usage observation, Responses forwarding, and Anthropic
  bridge behavior use their generic paths;
- no KTransformers-specific forwarding code is added unless an upstream
  incompatibility is demonstrated by a fixture.

### Model identity

Stopped-instance identity resolves in this order:

1. typed `servedModelName`;
2. typed `model` exactly as stored (preserve `org/model`, do not basename it);
3. no implied model.

When running, `/v1/models` verifies and may enrich the catalog. A mismatch
between the configured served name and the live response is a diagnostic
warning; it must not silently rename a public proxy model.

### Concurrency

Move `parseInstanceParallelLimit` behind an exhaustive engine concurrency
registry. KTransformers reads a positive `--max-running-requests`; an omitted
value yields no manager-side per-target cap and leaves SGLang's own admission in
charge.

The manager limit protects its lease/domain queue; it is not presented as an
exact model throughput prediction.

### Idle-only eviction

Thread the persisted eviction policy into scheduler inputs. Before choosing a
KTransformers target for eviction:

- runtime state must be ready/loaded;
- `activeRequests` must be zero;
- there must be no running lease holder for that target;
- drain/self-update logic must have reached its existing safe stop point.

If no eligible target can be evicted, the request waits or returns the existing
capacity/scheduling error; the scheduler does not override `idle-only` merely
because the competing request has higher priority.

Cold-start duration and artifact size are recorded for diagnostics if available
but do not influence scoring in MVP. A later cost-aware scheduler may use them.

### Managed upstream authentication

The initial supported topology is:

```text
client -> authenticated llama-manager -> loopback unauthenticated SGLang-KT
```

The form defaults `--host 127.0.0.1`; changing to a wildcard host produces a
security warning. `--api-key` is blocked because managed probes and endpoint
catalog rows do not yet carry a managed-upstream secret. Supporting it later
requires an explicit secret reference, auth headers for probes and forwarding,
redaction, and federation rules.

## Web UI plan

### Environments

Generalize the Environments view instead of adding a second page:

- engine selector: vLLM or KTransformers;
- engine-specific version label and source form;
- for KTransformers PyPI source, show the matched root pair;
- for offline wheels, collect one artifact for each required distribution;
- display exact resolved root versions, Python, platform availability, entrypoint,
  and freeze link/status;
- keep create/rebuild/delete/cancel semantics and a single active environment
  job unless the runner is deliberately generalized later.

### Instance form

Add a KTransformers engine section containing:

- main model: HF repo id or local directory;
- CPU expert weights: local directory picker/free text;
- KT method select;
- served model name;
- host and port, defaulting to `127.0.0.1:30000`;
- detected physical cores and `kt-cpuinfer` recommendation;
- detected NUMA nodes, thread-pool count, and explicit node multiselect/order;
- GPU selection and tensor parallelism;
- GPU expert count or ratio;
- required host/GPU reservation editor;
- advanced SGLang/KT arguments from the argument catalog;
- eviction policy, default `idle-only`.

The form must not show llama GGUF launch modes, router presets, rpc workers,
slot controls, llama-native panels, or vLLM positional-model copy.

Initialization, preview, submit, edit, and memory-estimate eligibility must be
descriptor/config driven. Do not add another pair of broad
`kind === "ktransformers"` branches parallel to the current vLLM branches;
small rendering selection for an engine-specific form component is acceptable.

### Instance details

Initial details use existing generic panels:

- health and readiness;
- configured and live model identity;
- logs and load progress;
- full process-tree memory layout;
- NUMA placement;
- resource reservations;
- proxy target/runtime state;
- start, drain, stop, restart.

No llama Models, Slots, Capabilities, or embedded llama Web UI controls are
rendered. SGLang `/metrics` and native management endpoints are deferred.

## Argument catalog

Add `sglang-help` with invocation:

```text
<venv>/bin/sglang serve --help
```

Factor the existing vLLM argparse normalization into a reusable parser rather
than copying it. Requirements:

- skip import/log preamble before `usage:`;
- preserve argparse groups;
- parse aliases, choices, defaults, booleans, and multi-value hints;
- categorize `--kt-*` arguments as KTransformers;
- cache by binary path, size, mtime, and parser id;
- run asynchronously with an engine-specific timeout;
- store the exact source command in the catalog response.

Bundle a conservative fallback catalog for the required KTransformers and
SGLang launch fields. Live help or a matching sidecar is authoritative. The
fallback exists so the form remains usable when importing SGLang help fails on
an incompatible node; it does not make that environment launchable.

## Federation and compatibility

This work needs a staged rollout because strict engine enums cross node
boundaries.

1. Before KTransformers is creatable, make remote instance/catalog parsing
   tolerate an unknown engine string and preserve a sanitized unsupported
   record.
2. Add node capability data including protocol version and supported managed
   engine kinds.
3. A sending node omits or marks unsupported engine-specific actions when the
   receiver does not advertise KTransformers support.
4. Unknown remote kinds appear in diagnostics but cannot become local managed
   proxy targets or receive lifecycle commands.
5. Upgrade all federation peers to the tolerant protocol before enabling
   KTransformers instance creation on any node.

Persisted local `InstanceKind` remains strict. Adding `ktransformers` requires no
migration for existing instance files; legacy files still default to
`llama-server` as today.

## Delivery phases

Each phase should be independently reviewable. A kind may exist in schemas
before it is exposed, but no production UI may create a configuration that the
current API cannot provision, validate, supervise, and account correctly.

### Phase 0 — real-hardware spike

Run the pinned wheel pair on a representative supported CUDA/NUMA host and
capture fixtures; no product code.

Answer and record:

1. wall time and output of `sglang serve --help`;
2. exact `/health` status sequence during model load and warmup;
3. `/v1/models` before and after readiness;
4. SIGTERM to root and process group with idle and active requests;
5. complete process tree and process-group/cgroup membership;
6. RAM/VRAM placement across root and workers;
7. representative logs for native and LLAMAFILE or AMX backend;
8. behavior of `--kt-numa-nodes` on the target topology;
9. behavior when CPU weights, CPU ISA, RAM, or VRAM are invalid/insufficient;
10. OpenAI chat and Responses streaming through a direct client.

Artifacts: sanitized log fixtures, process-tree snapshot, probe timeline, launch
commands, and an upstream-version note committed under tests/docs as
appropriate.

Acceptance: every P0 lifecycle assumption in this document is verified or the
document is amended before implementation continues.

### Phase 1 — contracts and compatibility preparation

- add `ktransformers` kind with `form.creatable:false`;
- add descriptor ids for argparse argv, SGLang help/logs, KTransformers
  preflight/resources, process-tree policy, concurrency, and eviction default;
- implement generic `argparse-flags` with tests;
- introduce typed engine configuration and scheduling schemas;
- validate kind/config matching and reserved-key ownership;
- make federation wire parsing unknown-kind tolerant;
- add capability advertisement needed for staged rollout;
- update descriptor exhaustiveness tests and documentation tables.

Acceptance:

- existing configs and tests remain unchanged in behavior;
- KTransformers records can round-trip through local schemas/API fixtures;
- old/unknown remote engine fixtures do not break remote catalog collection;
- KTransformers is not visible in the create form.

### Phase 2 — environment provisioner generalization

- create the API-side provisioner registry;
- move vLLM package/entrypoint/validation behavior behind its provisioner
  without changing stored vLLM behavior;
- add the KTransformers source schema and matched-pair installer;
- validate `bin/sglang`, imports, exact versions, freeze, and final layout;
- register/reconcile `engineKind:ktransformers` Path Catalog entries;
- generalize environment availability and UI records;
- extend create/rebuild/delete/cancel tests for both engines;
- cover failed second-root install and transactional cleanup.

Acceptance:

- existing vLLM environment tests remain valid;
- installing KTransformers publishes only after both packages and validation
  succeed;
- failure/cancel leaves neither a final environment nor a catalog entry;
- rebuild from the same spec reproduces the root pins;
- delete is refused while any instance references the generated entry.

### Phase 3 — launch, preflight, logs, and process telemetry

- compile typed configuration into `sglang serve` argv;
- implement KTransformers preflight and support matrix;
- implement/refactor `sglang-help` and fallback catalog;
- implement SGLang log parser using phase-0 fixtures;
- apply descriptor process-tree policy to RAM/VRAM/swap/NUMA collection;
- preserve llama router recovery semantics;
- make health status text descriptor-aware without changing documented legacy
  strings for existing kinds;
- add lifecycle integration tests with a fake SGLang-compatible executable.

Acceptance:

- a manually configured supported instance passes preview and start preflight;
- launch snapshot is exactly reproducible and drift-aware;
- fake server moves loading -> ready only from HTTP health;
- stop terminates every fake descendant;
- adoption succeeds from the `bin/sglang` root command line;
- memory layout contains descendants and never attributes unrelated processes.

### Phase 4 — resource and NUMA safety

- add `ktransformers-hybrid` resource profile;
- enforce host and selected-GPU reservations;
- integrate KT NUMA form fields and compatibility validation;
- hide/limit manager interleave controls for KTransformers;
- add reservation, CUDA visibility, TP, CPU-core, and NUMA tests;
- expose declared-versus-measured diagnostics.

Acceptance:

- an instance without required draws cannot start;
- selected GPU pools match CUDA visibility and TP order;
- invalid multi-NUMA combinations fail before spawn;
- all descendant memory contributes to measured layout;
- scheduler cannot admit a conflicting instance based on root-PID-only usage.

### Phase 5 — web creation flow

- generalize Environments view with engine-specific forms;
- add KTransformers instance section and typed form state;
- make preview/edit/submit share one serializer;
- wire argument catalog, hardware recommendations, reservations, and policy;
- verify instance details gating for `nativeApi:none`;
- keep descriptor `form.creatable:false` until the end of the phase, then enable
  it in the same deployable change.

Acceptance:

- install environment -> create instance -> preview -> create -> start ->
  observe -> stop works without raw JSON editing;
- edit round-trips every typed and advanced field;
- no llama/vLLM-only controls appear;
- unsupported environment/hardware combinations are visible but cannot launch.

### Phase 6 — proxy, concurrency, and eviction

- add descriptor-driven concurrency parsing;
- derive stopped model identity from typed configuration;
- add persisted scheduling policy and scheduler gates;
- enforce idle-only eviction and drain behavior;
- verify generic OpenAI and Anthropic-bridge forwarding;
- verify chat completions and Responses, streaming and non-streaming;
- verify no llama model/slot/resume/timing action is emitted;
- add local and federated target tests.

Acceptance:

- a stopped KTransformers target autostarts through the public proxy;
- excess requests queue according to `--max-running-requests` when configured;
- active KTransformers leases are never evicted under `idle-only`;
- idle instances can be stopped to admit a competing target;
- public model identity remains stable across path moves and restarts;
- stats/traces work without llama SSE timing extensions.

### Phase 7 — real-engine qualification and release

- execute the end-to-end flow on the phase-0 supported host;
- qualify at least one native/converted KT method and one LLAMAFILE flow when
  hardware and upstream support permit;
- exercise manager restart/adoption and self-update drain;
- validate raw/filtered logs and probe-noise filtering;
- measure cold start, shutdown, RAM, VRAM, swap, and NUMA placement;
- document operator prerequisites, known-safe defaults, troubleshooting, and
  the supported version matrix;
- update README, `ENGINE_ADAPTERS.md`, `ENVIRONMENTS.md`, resource docs, and API
  proxy docs;
- add a feature flag or release note requiring federation peers to be upgraded
  before KTransformers creation is enabled.

Acceptance: all MVP definition-of-done items below pass against a real pinned
environment, not only fakes.

### Phase 8 — post-MVP work

Independent follow-up projects:

1. `sglang-kt-reservation` memory estimator and calibration;
2. per-NUMA-node resource pools and multi-node cpuset isolation;
3. managed HF download/cache catalog;
4. CPU-weight conversion jobs with checksums and provenance;
5. versioned KTransformers launch profiles;
6. source-build provisioner profiles and machine-specific build artifacts;
7. ROCm and other accelerator qualification;
8. managed-upstream API-key secret references;
9. SGLang-native metrics/diagnostics panels;
10. cost-aware residency scheduling using measured cold-start time;
11. stable upstream dynamic weight replacement, if it becomes suitable for the
    lifecycle contract;
12. a generic plain-SGLang engine kind reusing the SGLang adapters.

## Test strategy

### Core unit tests

- descriptor completeness and exact KTransformers capabilities;
- typed config parse, update, persistence, kind mismatch, and reserved args;
- argparse scalar/flag/list/CSV behavior and deterministic ordering;
- launch snapshot and drift behavior;
- scheduling policy defaults and persistence;
- eviction-policy planning;
- concurrency parsing;
- hybrid resource-profile derivation.

### API unit tests

- provisioner requirement and validation commands;
- multi-root PyPI and wheel sources, URL credential rejection, hashes;
- environment transactional failure/cancel/rebuild/delete;
- path-catalog reconciliation and kind validation;
- KTransformers preflight table tests;
- SGLang help parsing and fallback behavior;
- SGLang logs for progress, warnings, tracebacks, OOM, ready marker;
- health 503/200 transitions;
- descendant ownership, memory, swap, VRAM, and unrelated-process exclusion;
- model identity and mismatch diagnostics;
- proxy capabilities, concurrency, idle-only eviction, and forwarding;
- federation with known, unknown, supported, and unsupported peer kinds.

### Web tests

- environment engine/source state serialization;
- instance create/edit round trip;
- required two-model-input validation;
- method, NUMA, CUDA/TP, reservation, and policy controls;
- preview error field mapping;
- engine-specific panel visibility;
- binary filtering by tagged Path Catalog entry.

### Integration tests with a fake executable

Provide a lightweight executable/script fixture that:

- accepts `serve` and argparse-style flags;
- spawns named descendants;
- serves `/health`, `/v1/models`, and minimal OpenAI streaming endpoints;
- transitions from 503 to 200 on command/timer;
- emits representative SGLang logs;
- handles SIGTERM and can simulate a stuck child;
- records received argv for assertions.

This covers lifecycle deterministically without requiring CUDA in CI.

### Real-hardware qualification matrix

Record for every qualified pair:

| Dimension | Required record |
| --- | --- |
| Manager commit | exact SHA |
| KTransformers roots | exact `kt-kernel` and `sglang-kt` versions |
| Python | exact version and uv version |
| OS/architecture | distro, kernel, glibc, x86-64 |
| CPU | model, physical cores, NUMA topology, ISA features |
| GPU | model count, driver, visible devices, VRAM |
| Model bundle | main model, CPU weights, checksums/revisions |
| KT config | method, threads, nodes, GPU experts |
| SGLang config | TP, memory fraction, concurrency, context |
| Outcomes | load time, ready time, tokens, shutdown, RAM/VRAM/swap |

Do not call an unqualified combination supported merely because environment
installation succeeds.

## Migration and rollout plan

1. Land schema/remote-tolerance work with KTransformers non-creatable.
2. Upgrade federation peers to that release.
3. Land environment and lifecycle support, still non-creatable by default.
4. Run managed environment and fake lifecycle qualification.
5. Enable `form.creatable` only with the complete web/resource/preflight path.
6. Qualify real hardware and publish the exact support matrix.
7. Enable production use through release notes/feature flag according to the
   deployment's federation state.

Rollback properties:

- existing instance and vLLM environment files remain readable throughout;
- disabling KTransformers creation does not delete specs or environments;
- KTransformers instances can be stopped and left configured while the feature
  is disabled;
- generated environments are immutable and safe to delete/rebuild;
- unknown remote kinds degrade to unsupported records, not fatal parse errors.

## Expected file areas

This is a routing map, not a requirement to place every change in one commit.

| Area | Expected work |
| --- | --- |
| `packages/core/src/engine-descriptor.ts` | kind, ids, descriptor, process/concurrency/eviction declarations |
| `packages/core/src/index.ts` | typed engine config, scheduling, environment source/spec schemas |
| `packages/core/src/instance-resources.ts` | KTransformers hybrid profile |
| `apps/api/src/envs/` | provisioner registry, matched-pair install/validation, availability |
| `apps/api/src/process/argv.ts` | argparse builder |
| `apps/api/src/process/preflight*.ts` | KTransformers preflight and registry |
| `apps/api/src/process/log-parsers/` | reusable SGLang parser and fixtures |
| `apps/api/src/process/runtime-memory.ts` | descriptor-driven descendant ownership |
| `apps/api/src/arguments/` | SGLang help parser/invocation/fallback |
| `apps/api/src/proxy/` | model identity, concurrency registry, eviction policy, federation tests |
| `apps/api/src/nodes/` | capability negotiation and unknown-kind handling |
| `apps/web/src/ui/views/EnvironmentsView.tsx` | engine-specific environment creation |
| `apps/web/src/ui/components/` | typed KTransformers form and details gating |
| `docs/` | durable engine, environment, resource, proxy, operations documentation |

## Risks and controls

| Risk | Control |
| --- | --- |
| Upstream package skew | Pin and validate both root distributions exactly |
| Wheel installs but hardware is incompatible | Separate environment availability from strict instance preflight |
| Uvicorn is up before model warmup | HTTP `/health` is authoritative |
| Worker memory is missed | All-descendant ownership and real process-tree qualification |
| Scheduler evicts a huge active model | Persisted `idle-only` policy enforced before planning |
| NUMA wrapper fights KT thread pools | KT owns inner placement; manager interleave rejected |
| Raw args disagree with form | Typed required config and reserved-key rejection |
| Offline install has only one root wheel | Require complete artifact set before starting the job |
| Public model name changes after moving files | Persist served model identity; do not basename paths |
| Old federation peer rejects new kind | Tolerant wire schema and staged peer upgrade |
| Source-build feature leaks into wheel MVP | Explicit support profiles and separate deferred provisioner |
| Manual reservations are wrong | Preflight, capacity confirmation, runtime drift diagnostics, later estimator |

## MVP definition of done

KTransformers support is complete for the initial profile only when all of the
following are true:

1. A user can install an immutable, pinned `kt-kernel` + `sglang-kt`
   environment from the Environments UI/API.
2. The generated `bin/sglang` appears in Path Catalog tagged
   `ktransformers`.
3. A user can create and edit an instance with main model, CPU weights, method,
   networking, CPU/NUMA/GPU settings, reservations, and idle-only policy without
   raw config editing.
4. Preview and start preflight reject unsupported hardware, invalid paths,
   missing reservations, invalid NUMA/TP settings, reserved arg collisions, and
   managed upstream API keys.
5. The process launches with deterministic `sglang serve` argv and reaches ready
   only after HTTP health returns 200.
6. Manager restart adopts the root process without duplicating it.
7. Normal stop and shutdown leave no SGLang/KT descendants.
8. RAM, VRAM, swap, and NUMA diagnostics include the complete process tree.
9. The resource ledger prevents conflicting admission using declared draws.
10. The public proxy autostarts the target and serves chat completions and
    Responses in streaming and non-streaming modes.
11. Configured concurrency limits queue excess manager leases.
12. Active requests are never evicted under the default policy; idle instances
    remain eligible for stop-based residency changes.
13. Public model identity is stable while stopped, running, restarted, and moved
    between local filesystem paths.
14. Existing llama-server, rpc-worker, vLLM, environments, proxy, and federation
    behavior passes regression tests.
15. At least one real supported model/hardware combination passes the recorded
    qualification matrix and operator documentation is published.

Anything less is partial plumbing and must remain non-creatable or explicitly
experimental.
