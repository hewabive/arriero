# Background-job kernel (`apps/api/src/jobs/`)

Generic machinery for supervised background jobs, shared by the four job
domains — `build`, `envs`, `update`, `sources` — and, as part of the update
kit, copied byte-identically into `llm-arena` and `rag-manager`
(`docs/SELF_UPDATE.md` § Shared kit contract; the canonical contract text
lives in `llm-arena/docs/self-update.md`). The kernel is plain TypeScript
generics over structural job types: it imports nothing repo-specific — no
`core` package, no domain modules — so each repo's domains keep their own Zod
schemas and public API shapes.

## Modules

- **`store.ts`** — in-memory job stores with `structuredClone` at both
  boundaries. `createJobStore({historyLimit})` keys jobs by id, lists newest
  first, and trims the oldest finished jobs beyond the limit (running jobs are
  never trimmed). `createLatestJobStore()` keeps one latest job per entity key
  (sources: per `sourceId`). `patch` merges partial input and always preserves
  `id`. The base shape is `BackgroundJobBase`:
  `{id, status, startedAt, finishedAt, error}` with the four-value status enum
  mirrored in each repo's core as `BackgroundJobStatusSchema`.
- **`steps.ts`** — step-array transitions for step-shaped jobs
  (`build`/`envs`/`update`). `markJobStep(store, jobId, name, patch)` replaces
  the named step and sets `currentStep` when the patch marks it `running`.
  Step status stays a plain string: domains own their enums (`skipped`,
  `warning` are build-only).
- **`exec.ts`** — `runLoggedCommand(command, {log, cwd, env, signal,
  collectStdout})` spawns detached (own process group on POSIX), pipes
  stdout/stderr into the log sink, and on `AbortSignal` kills the whole
  process group — children of `pnpm`/`cmake`/`uv` die with their parent.
  Returns `{exitCode, stdout}`; `stdout` is collected only when requested.
  Command echo lines (`$ …`) stay with callers so each domain keeps its log
  format.
- **`registry.ts`** — the process-wide active-job registry, keyed by
  `(domain, entityId)`. `registerActiveJob` attaches auto-deregistration to
  the completion promise; `getActiveJob`/`listActiveJobs`/`anyActiveJobs`
  answer busy queries (config-git tree-op guard); `shutdownActiveJobs`
  cancels everything and waits with a timeout — the single shutdown path in
  `index.ts`.
- **`log-tail.ts`** — `tailJobLog(jobId, job, lines)` over
  `utils/log-tail.ts` for the per-domain `GET …/logs` endpoints.

## Domain mapping

| Domain | Store | Progress model | Registry domain |
| --- | --- | --- | --- |
| build | `buildJobs` (history 20) | steps | `build` |
| envs | `environmentJobs` (history 20) | steps | `envs` |
| update | `updateJobs` (history 10) | steps | — (see below) |
| sources | latest-per-`sourceId` | phase + progress % | `source` (entity = sourceId) |

Deliberate asymmetries:

- **update does not register in the registry.** Its restart step ends with a
  self-`SIGTERM`; a registry entry would let `shutdownActiveJobs` cancel the
  very job that initiated the restart. Update jobs were never
  shutdown-canceled and still are not.
- **sources keep `sources/state.ts`** (the per-source operation mutex) in
  addition to the registry: it also guards short synchronous git operations
  (`set-origin`, the llama checkout) that are not jobs. The registry tracks
  only the background clone/pull jobs; `build` checks the mutex, config-git
  checks both.
- Registry domain names are plain string literals owned by each domain
  (`"build"`, `"envs"`, `"source"`); the kernel has no domain enum by design.

## Cancellation

One convention everywhere: an `AbortController` per running job. `cancel()`
marks the job `canceled` (terminal, `error: "canceled by user"`) and aborts;
`runLoggedCommand` kills the process group; the run loop re-checks the
canceled flag after each await and stops without overwriting the terminal
state. Sources instead let the abort surface as a rejected git promise and
map it to `canceled` in the completion handler.
