# CLAUDE.md — @arriero/core

The contract layer. All request/response shapes and shared types are Zod schemas exported from
`src/index.ts` (e.g. `InstanceCreateSchema`, `ApiProxyTargetRecord`, `RuntimeState`). Both api and web
import from here; it is the single source of truth, so **a new shape is added here first** and only
then consumed.

Keep it free of runtime concerns: no I/O, no api-only helpers. Pure derivations shared by both sides
are welcome and belong here rather than being duplicated (the resource ledger `buildResourceLedger` /
`checkDrawAdmission`, `impliedInstanceModelId`, `argumentDefaultsForKind`).

Per-`InstanceKind` engine specifics hang off `engineDescriptor` (`src/engine-descriptor.ts`):
probe / log-parser / preflight / estimator / arg-catalog-parser / argv-builder ids, `nativeApi`
gating the web llama panels, and the proxy capability flags gating slot-save, stream-resume,
model-load and SSE timings. It is implemented by api-side registries and read by the web kind
selector and gates — contract and the new-engine checklist are in `docs/ENGINE_ADAPTERS.md`.

In dev the `development` exports condition resolves this package straight to `src`, so edits apply
live with no rebuild; `dist` stays the artifact for production and api tests.
