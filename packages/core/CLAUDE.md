# CLAUDE.md — @arriero/core

The contract layer. All request/response shapes and shared types are Zod schemas exported from
`src/index.ts` (e.g. `InstanceCreateSchema`, `ApiProxyTargetRecord`, `RuntimeState`). Both api and web
import from here; it is the single source of truth, so **a new shape is added here first** and only
then consumed.

Keep it free of runtime concerns: no I/O, no api-only helpers. Pure derivations shared by both sides
are welcome and belong here rather than being duplicated (the resource ledger `buildResourceLedger` /
`checkDrawAdmission`, `impliedInstanceModelId`, `argumentDefaultsForKind`).

Update schemas derive from their record schema via `updateSchemaFrom` (`src/schema-update.ts`),
which strips zod `.default(...)` wrappers before making every field optional — a bare `.partial()`
re-applies record defaults to omitted fields, turning a partial update into a reset. Per-field
deviations (e.g. a nullable-to-clear field, an extra `apiKey`) go in an `.extend()` on top.

Per-`WebappKind` specifics hang off `webappDescriptor` (`src/webapp-descriptor.ts`) the same way as
the engine descriptor below — contract in `docs/WEBAPPS.md`. Per-`EnvironmentEngine` specifics
(variants, Python versions, distributions, create-form facts) hang off `environmentDescriptor`
(`src/environment-descriptor.ts`) — contract in `docs/ENVIRONMENTS.md`.

Per-`InstanceKind` engine specifics hang off `engineDescriptor` (`src/engine-descriptor.ts`):
probe / log-parser / preflight / estimator / arg-catalog-parser / argv-builder ids, `nativeApi`
gating the web llama panels, and the proxy capability flags gating slot-save, stream-resume,
model-load and SSE timings. It is implemented by api-side registries and read by the web kind
selector and gates — contract and the new-engine checklist are in `docs/ENGINE_ADAPTERS.md`.

In dev the `development` exports condition resolves this package straight to `src`, so edits apply
live with no rebuild; `dist` stays the artifact for production and api tests.
