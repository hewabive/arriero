# Instance definitions

The `instances` domain (`apps/api/src/instances/`) owns the **definition** of a managed engine
process: the stored record, its runtime projection, write semantics, cross-reference validation, and
the endpoint/profile derivations other domains consume. It deliberately does not own the runtime —
supervision, preflight, logs and health are the process domain (`apps/api/src/process/CLAUDE.md`);
storage, identity and the rename/delete cascades are `docs/CONFIG_FILES.md` → instances section; the
status vocabulary is `docs/STATUS_LAYERS.md`.

## The record and its runtime projection

`InstanceConfigRecord` (core `instance.ts`) is the stored shape; the API always serves `Instance`,
which extends it with runtime `status`/`pid` derived on every read
(`instances/repository.ts:toInstance`):

- **`status`/`pid`**: the supervisor's in-memory runtime wins; otherwise the latest `process_runs`
  row (a status outside the L1 enum coerces to `stopped`); otherwise `stopped`. The DB fallback is
  what keeps status truthful between manager restart and run adoption.
- **`binaryPath`**: `binaryPathRefId` re-resolves against the path catalog on every read, so a
  catalog edit repoints every instance holding the ref. The inline `binaryPath` snapshotted at write
  time is only the fallback for a since-deleted catalog entry. Creating requires the ref; `kind` is
  immutable after create (`InstanceUpdateSchema` has no `kind`).
- **`scheduling`** absent ⇒ `engineDescriptor(kind).defaultEvictionPolicy`.

## Write semantics

- Create and update both re-validate the complete record with `InstanceConfigRecordSchema`. The
  KTransformers invariants — kind `ktransformers` requires the typed `engineConfig`, other kinds
  reject it, reserved arg keys (`--model`, `--kt-method`, …) refused in `args` — are core schema
  refinements, not route code.
- `writeInstanceRecord` sorts `args`/`env` keys so the per-instance JSON diffs stay stable under
  config-git.
- PATCH merges field-by-field with the stored record, **except `numa` and `reasoning`, which are
  omit-to-clear**: a PATCH without them drops the stored value. The web form always serializes the
  full definition and clears NUMA/reasoning by omission (`use-instance-form.ts`); an agent or script
  PATCHing a single field must resend both to keep them.
- Rename is a PATCH with a new `name`: refused with 409 while a supervisor runtime is active or an
  open process run exists (`rename.ts:assertInstanceRenameAllowed`). What the cascade rewrites is in
  `docs/CONFIG_FILES.md`.
- DELETE stops the supervised child and any stale pid first (2 s budget each,
  `process/stale.ts:stopStaleProcess`) and returns 400 if a stale pid survives — the record is
  removed only once nothing runs under the name.

## Cross-reference checks

After the Zod parse, `routes/instances.routes.ts` validates references as plain-string errors:
`binaryPathRefId` must resolve to a catalog entry of kind `binary` whose `engineKind` tag, when set,
matches the instance kind; every `memory[].poolId` must name an existing pool; an `rpc-worker`
instance cannot itself reference rpc workers (`instances/validation.ts`).

## Endpoint derivation

`instances/endpoint.ts:instanceBaseUrl` derives the HTTP base URL from the args through the engine
descriptor's `http` block (per-kind arg keys and defaults: `docs/ENGINE_ADAPTERS.md`); the first
present host/port/prefix arg key wins. Wildcard hosts `0.0.0.0` / `::` are probed at `127.0.0.1`; a
host ending in `.sock` means no HTTP endpoint (empty base URL, `null` from `rpcWorkerEndpoint`); an
api prefix is normalized to a single leading slash.

For an instance with an active run (`starting` / `running` / `stopping` / `stale`),
`process/runtime-endpoint.ts` overlays host, port and prefix from the run's launch snapshot before
deriving — editing a running instance's port must not repoint probes, the proxy or the benchmark
until restart. Anything touching a live process uses the `runtime*` variants; the plain functions
describe the definition.

`requestJsonProbe` is the shared probe primitive: JSON-or-text body, 1.5 s default timeout, never
throws — failure comes back as `{ ok: false, error, latencyMs }`. Consumers include the llama
probe/capabilities, the engine probe, the benchmark runner, the api-lab and rpc preflight/launch.

## Derived profiles

- **Resource profile** (`instances/resource-profile.ts` → core `deriveInstanceResourceProfile`):
  which memory pools a definition draws on, joined with cached GGUF metadata
  (`blockCount`/`expertCount`) and, for `llama-args` engines, the cached `--n-gpu-layers` binary
  default. Bulk endpoint `GET /api/instances/resource-profiles`; semantics in
  `docs/RESOURCE_MANAGEMENT.md`.
- **Reasoning profile** (`instances/reasoning-profile.ts`): instance override → chat-template
  autodetect → engine default, TTL-cached; the whole chain is `docs/API_PROXY_REASONING.md`.

## Route surface

`/api/instances*` fronts more than this domain owns; logic lives with the owner:

| Route | Owner |
| --- | --- |
| list / create / get / patch / delete | this domain |
| `POST /api/instances/preflight` · `GET /:id/preflight` | process preflight |
| `GET /:id/runtime` · `/:id/logs` · `/:id/status-summary` · health-summary (list and per-id) | process |
| `POST /:id/memory-assessment` (+`/measure`) · `GET /:id/memory-assessment/report` | memory-assessment (`docs/MEMORY_ESTIMATION.md`) |
| `GET /:id/reasoning-profile` | reasoning profile above |

`POST /api/instances/preflight` previews a definition that may not be saved yet: `name` is optional,
and with a name the port-conflict check tolerates the instance's own active listener (edit form)
while without one any active listener on the port conflicts (create form). Capacity admission
excludes the instance's own draws in both preflight routes.

## Boot

- A quarantined definition file (invalid JSON or schema) surfaces through the config-store; at boot
  `process/reconcile.ts` **defers** its open process run — neither adopts nor marks it stale — while
  the pid still matches the launch snapshot, so fixing the file and reloading lets the process be
  adopted instead of flagged.
- The legacy `numaNode` → `numa` rewrite is migration `0008` (`instances/numa-migration.ts`,
  `docs/MIGRATIONS.md`).
