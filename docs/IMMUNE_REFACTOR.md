# IMMUNE refactor plan

Working document. Delete it — and its CLAUDE.md pointer — when every stage is done.

## Diagnosis

The repository already practises the IMMUNE principles better than most codebases. The gap is
uniform and single-cause: **compliance is voluntary everywhere it matters.** There is no CI, no git
hook, and `pnpm check` runs neither the tests nor five of the seven checkers that already exist.
For a repository written exclusively by agents, an unenforced rule is a coin flip per session.

The worst instance is inside the verification mechanism itself: `apps/api`'s test script globs
`src/**/*.test.ts` unquoted, so the shell expands it to `src/*/*.test.ts` and six test files never
execute — while the runner prints `1254 pass, 0 fail` with no indication of a skip. Two of the six
are the regression tests written for the vLLM and SGLang point fixes; they have never run.

Stage order follows one rule: **a check lands before the change it protects.**

## Measured baseline (2026-08-08, commit `2655bab`)

| Check | Command | Status | In `pnpm check`? |
| --- | --- | --- | --- |
| React event captures | `pnpm check:events` | green (179 files) | yes |
| Typecheck ×4 | `pnpm -r check` | green | yes |
| api tests | `pnpm --filter @arriero/api test` | green, **1254 of 1286** discovered | no |
| bridge tests | `pnpm --filter @arriero/anthropic-openai-bridge test` | green (25) | no |
| Formatting | `npx prettier --check .` | **red** — 4 files | no (no `format:check` script exists) |
| Dead code | `pnpm knip` | **red** — 22 findings | no |
| Arg-doc quality | `pnpm --filter @arriero/api args:docs:quality` | green (252 docs) | no |
| Arg-doc source sync | `pnpm --filter @arriero/api args:docs:source-sync` | green, `inSync`, no phantom rows | no |
| GGML type table | `pnpm memory:check-ggml-types` | green (35 types) | no |
| Update-kit drift | `node scripts/check-update-kit.mjs` | green (16 files × 2 siblings) | no, and no package.json entry |

The six unreachable test files pass when run explicitly (32 tests). Quoting the glob raises the api
suite to 1286 with zero failures — verified. `pnpm -r --if-present run test` drives both suites.

Three checkers read machine state absent from a fresh checkout: `check-ggml-types` and
`args:docs:source-sync` need `runtime/sources/llama.cpp`; `check-update-kit` needs the sibling
repositories. They cannot be unconditional members of `pnpm check`.

## Stage 1 — Close the gate — **done**

Nothing later is trustworthy until this lands.

Landed as `1eb5c66` (test discovery), `90015c6` (formatting), `53d5cab` (gate composition),
`ee138fc` (knip), and the hook commit below. `pnpm check` is now one green command covering events,
formatting, build, typecheck, knip, arg-doc quality and 1287 tests; `pnpm check:sources` covers the
three machine-state checkers separately.

Enable the hook once per clone — `core.hooksPath` is local git config, not tracked:

```bash
git config core.hooksPath scripts/hooks
```

`ARRIERO_SKIP_HOOKS=1 git push` is the deliberate escape hatch.

- Quote the api test glob so Node, not the shell, expands it. One character; 1254 → 1286.
- Add a test asserting the runner's discovered-file count equals a `find` over `src`, so an
  unreachable test file fails loudly instead of vanishing. This is the mechanism fix for the bug
  class, not the bug.
- Run `pnpm format` (4 files), add a `format:check` script (`prettier --check .`).
- Extend root `check` to: `check:events` → build core+bridge → `pnpm -r check` →
  `pnpm -r --if-present run test` → `format:check` → `args:docs:quality`.
- Add a second target `check:sources` for the three machine-state checkers. Each must exit
  **non-zero with a distinct code** when its input is missing rather than passing silently.
  `check-ggml-types` already separates exit 2 (input absent) from exit 1 (drift) — copy that shape
  into `check-update-kit`, which currently `continue`s past an absent sibling and reports success.
  Give `check-update-kit` a package.json entry.
  `args:docs:source-sync` calls `migrate()`; point it at a throwaway DB before putting it in any
  gate.
- Triage the 22 knip findings, then wire knip into `check`.
- Install the enforcement point. Both `.claude/` and `.codex/` skills exist here, so it must be
  tool-agnostic: a tracked `scripts/hooks/pre-push` plus `git config core.hooksPath scripts/hooks`
  in the setup instructions. GitHub Actions optional on top.

**Acceptance:** `pnpm check` is one command, green, and runs 1311 tests; deleting a test file's
directory entry or adding an unreachable one fails the gate; `check:sources` fails loudly on a
checkout without llama.cpp instead of reporting success.

**Not in scope:** turning on knip's `duplicates` rule (see stage 6).

## Stage 2 — Coherence checks for the unprotected pairs — **done**

Cheap, and it protects stages 4–6.

Landed as `4ad1d7c` (doc claims), `18fdd29` (env), and the schema-parity commit below.
`pnpm check` gained `check:docs` and `check:env`; the `db/schema.ts` ↔ `migrate()` pair is covered
by `db/schema-migrate-parity.test.ts`.

Two findings worth carrying forward. The doc-claims checker found a stale
`http.ts:proxyProtocolEndpoint` in `docs/API_PROXY_PREEMPTION.md` that manual reading had missed, so
its symbol check is deliberately strict: for an ambiguous filename it consults every candidate and
flags only when the symbol is in none. And the env checker had to resolve `managerEnv` /
`managedPath` / `envPath` before it was safe to run — the literal-grep version reported six working
variables as dead, and a further two names that match the pattern are not environment variables at
all.

- Fix the known drift first, or the new checkers are red on arrival:
  - CLAUDE.md: `http.ts` "defines every route" (it is a 119-line composition root; routes live in
    `src/routes/*.routes.ts`, a directory CLAUDE.md never names); `http.ts:proxyProtocolEndpoint`
    (→ `proxy/protocol-endpoint.ts:266`); `envs/uv.ts:findUv` (→ `probeUv`);
    `src/api/client.ts` "is the typed fetch layer" (it is a 19-line `export *` barrel; the layer is
    `api/http.ts` + `base.ts`); the `data/arriero.db` table list omits `memory_assessments`; the
    domain list omits `nvidia/`, `sources/`, `settings/`, `git/`; the commands block omits `knip`,
    `memory:calibrate`, `memory:check-ggml-types`.
  - `docs/API_PROXY_FOUNDATION.md:63-67` claims the executor "rejects preemption, slot save/restore
    and unload actions" — it implements all three.
  - `docs/API_PROXY_PREEMPTION.md:24` describes `proxy/coordinator.ts`, which does not exist, and
    corrects itself only six paragraphs later. **Rewrite the section; do not append another
    update.** Accreted corrections are worse than stale text for an agent that stops at the first
    matching passage.
  - `.env.example` documents 15 of the 34 variables the code reads. **Nothing in it is dead** — an
    earlier draft of this plan claimed six orphans, which was wrong: they are read through
    `managerEnv("SECURE_COOKIE")` / `managedPath("PYTHON_DIR", …)`, helpers that prepend the
    `ARRIERO_` prefix, so a grep for the literal name finds nothing. Of the 19 undocumented ones,
    seven are internal and should stay out (`ARRIERO_ENV_TEST_*`, `ARRIERO_TEST_ROOT`,
    `ARRIERO_HELP`, `ARRIERO_UI_COMMIT__`); the rest are operator-facing and belong in the file:
    `ARRIERO_HOME`, `ARRIERO_DATA_DIR`, `ARRIERO_LOGS_DIR`, `ARRIERO_BUILDS_DIR`,
    `ARRIERO_MODELS_DIR`, `ARRIERO_SLOTS_DIR`, `ARRIERO_ENVS_DIR`, `ARRIERO_FILTER_PROBE_LOGS`,
    `ARRIERO_NUMA_CGROUP_ROOT`, `ARRIERO_PROXY_IDLE_INTERVAL_MS`, `ARRIERO_SHUTDOWN_TIMEOUT_MS`,
    `ARRIERO_KT_RUNTIME`.
- `scripts/check-doc-claims.mjs`: across CLAUDE.md and `docs/*.md`, assert every backticked file
  path exists and every `` `file.ts:symbol` `` claim resolves to that symbol in that file. A 10-line
  prototype found two real drifts; 2 of 17 symbol claims were stale. Wire into `check`.
  It needs one distinction to be usable: a doc legitimately names paths that do **not** exist —
  files a plan proposes to create, and symbols quoted as drift to be fixed. Running the prototype
  against this document produced six such hits. Either scope the checker to prose outside fenced
  plan blocks, or require an explicit marker on absent-by-design references; do not weaken it to a
  warning.
- `scripts/check-env-example.mjs`: diff the variables the code reads against `.env.example`. It must
  resolve `managerEnv("X")` and `managedPath("X", …)` to `ARRIERO_X`, not grep literals — a literal
  grep produces six false orphans, and a checker in the gate that reports working configuration as
  dead is worse than no checker. It also needs an explicit internal-variable list, since test
  fixtures and the build stamp legitimately never appear in the example file.
- Test comparing `db/schema.ts` to `db/index.ts:migrate()`: open an in-memory DB, run `migrate()`,
  compare `PRAGMA table_info` per table against the Drizzle definitions. 70 columns across 7 tables
  are currently duplicated by hand with zero checks, and the two files are edited at near-identical
  frequency (46 and 44 lifetime touches) — the numeric signature of a hand-maintained duplicate.

**Acceptance:** every drift found in the 2026-08-08 audit would now fail the gate.

**Not in scope:** validating web's `/api/...` literals against registered routes (155 vs ~130
independent strings, no shared table). Worth doing later; too large for this stage.

## Stage 3 — Observability seam — **done**

Landed: the seam itself (`efb52e1` — `apps/api/src/logger.ts`, tests default `LOG_LEVEL=silent`,
the rule recorded in CLAUDE.md), the gpu-capacity fix and the status-layer trade record (`d5cfdd3`),
the fingerprint fix below, and `hasClassifierHead`, now `boolean | null` — a failed tensor-table read
yields `null` (and a `logger.warn`) instead of a manufactured `false`, and the scanner's
`emptyMetadata()` fallback follows. No branch changed: `ggufModelRole` treats `null` and `false`
alike, so the fix only makes the unknown representable. Cached rows keep their old `false` until
rescan — `GGUF_PARSER_VERSION` was deliberately not bumped, since a full re-parse buys nothing while
no consumer branches on the tri-state; bump it when one does. Both checkers landed in
`184e24b`, together with the eleven comments they cleared.

87 sites in `apps/api` swallow an error without a trace, and this is structural rather than
careless: `pino` is created at `index.ts:50` and never exported, and there are 6 `console.*` calls
in 51,565 lines. Library code has nowhere to report a non-fatal anomaly. Fix the seam, not the 87
catches.

- Move pino construction into `apps/api/src/logger.ts` and export it; `index.ts` imports it. The
  `onError`-injection idiom already used in ~17 modules stays the preferred form for background
  loops — this only gives library code a fallback.
- Record the rule in CLAUDE.md: a `catch` that neither rethrows nor returns a typed failure must
  log.
- `scripts/check-silent-catch.mjs`, AST-based like `check-react-event-captures.mjs`: flag empty
  catch bodies and `catch { return <literal> }` with no log call. It ships advisory (an `ENFORCING`
  constant, false for now) because ~87 sites are outstanding, and it is deliberately **not** wired
  into `pnpm check` while advisory: a gate step that always passes while printing dozens of findings
  trains everyone to skim past gate output, which costs more than it buys. It gets a script alias so
  it is discoverable and runnable, and moves into the gate in the same commit that flips `ENFORCING`.
  No baseline file — that would be a second owner of the rule, and it would only grow.

  Its first run is the useful part. 135 sites in 82 files, by reason: 80 return a bare literal, 47
  do something else without log/throw/returned failure, 8 are empty. A call that passes the caught
  binding as an argument counts as a trace — without that rule 28 sites were flagged for propagating
  correctly through `reject(error)`, a preflight issue, or an operator notification, and a checker
  that ships ~45% noise never gets its `ENFORCING` flipped.

  Triage of the 80 bare-literal sites, which is what turns this into a work list: **about 60 are
  semantically correct** — predicates where the throw *is* the answer (`accessSync` → false,
  `new URL()` inside a Zod refine, `JSON.parse` → `{}`) and optional-file readers where absence
  genuinely is the answer. The real targets are the ~13 remote or measurement calls where the empty
  value is indistinguishable from a real empty result — `proxy/endpoint-models.ts:56` returns `[]`
  when a provider is unreachable, `nodes/remote-instances.ts:21` returns `[]` for an entire remote
  node — plus three pure substitutions of a plausible value for unknown
  (`process/preflight-ktransformers.ts:524` returns `0` for SwapTotal, `proxy/request-files.ts:40`
  returns `0` for a file count, `proxy/request-text.ts:69` returns `""`).

  So the bare-literal criterion is **not** enforceable as written; the empty-catch (8) and
  broad-class (47) subsets are much closer. Enforce those first, and narrow the bare-literal rule to
  catches whose `try` performs I/O that can fail for reasons other than the value being absent.
- `scripts/check-no-comments.mjs` belongs here rather than in stage 1, because it lands on the same
  sites. The audit reported "9 comment lines in ~130k lines of non-test source"; that figure was
  measured with a grep anchored to the start of a line, so it **missed trailing comments**
  (`reader.u32(); // version` in `models/gguf.ts`) and everything in test files, while also counting
  the one allowed `@deprecated` pragma. The AST checker finds eleven real comments, which is still
  remarkable discipline — but it is the checker, not a grep, that gets to state the number. Three of
  them are comment-only `catch` bodies where the comment *is* the reason the swallow is acceptable —
  exactly what the silent-catch checker must judge. Resolve them once:
  relocate the rationale (the five-line SGLang block in `arguments/catalog.ts` belongs in
  `docs/KTRANSFORMERS_SUPPORT.md`), then enforce with no baseline file, since a baseline would be a
  second owner of the rule and would only grow. Scan for comment trivia with the TypeScript scanner,
  not a regex, so `//` inside strings and template literals is not flagged, and allow tooling
  pragmas — there is exactly one, the `@deprecated` JSDoc in `proxy/domain-admission.ts:67`, which
  is a machine-readable annotation rather than an explanation and should stay. Record that carve-out
  in CLAUDE.md so the rule and the checker agree.
  This must land before stage 5, because it guards the convention a delegated agent is most likely
  to break and that typecheck cannot see.
- Fix the highest-severity silent guesses by hand:
  - `resources/repository.ts:98` and `:172` — `capacityBytes: accelerator.totalMemoryBytes ?? 0`
    seeds a GPU whose VRAM could not be read as a zero-capacity pool, and admission then refuses
    everything on it. The same file already does this correctly at `:141-144` (`?? null`, skip).
    Make all three paths agree.
  - `process/health-summary.ts:245-250` returns `status: "ready"` when the readiness probe went
    unanswered. On inspection this is **not** a bug to flip: the branch is reachable only by engines
    with `httpHealth: false`, which today means `rpc-worker` alone, and a busy single-threaded RPC
    worker legitimately fails to accept the `tcp-accept` probe — escalating would alarm on healthy
    workers. The real defect was that the trade was unrecorded, so it is now written into
    `docs/STATUS_LAYERS.md` § Intentional cross-layer differences, together with the honest fix
    (an `unknown` member on `InstanceHealthSummaryStatus`) and why it is deferred. A known unknown
    is acceptable under U; a hidden one is not.
  - `models/gguf.ts` left `hasClassifierHead` at its initialised `false` on a tensor-table read
    failure, which downstream read as "not an embedding model". Fixed: the field is nullable, the
    failure logs, and the unknown is now distinguishable from a confirmed negative.
  - `memory-assessment/fingerprint.ts:49-58` returned/continued past unreadable directory entries,
    so a partial file set still produced a stable digest and a staleness check could pass that
    should have failed. Fixed by counting what could not be read and folding that count into the
    fingerprint through an optional `unreadableCount` on `FileIdentity`: a partial walk now yields a
    different digest, which surfaces as ordinary drift ("run it again") instead of false confidence.
    The pattern is the one `system/pci-inventory.ts` already uses — count the unreadable, never drop
    it — and the schema field is optional, so stored receipts keep parsing.

**Acceptance:** a new silent swallow fails the gate; unknown GPU capacity surfaces as unknown, not
as 0; no health verdict claims `ready` on an unobserved probe.

**Not in scope:** rewriting all 87 sites. The seam plus the checker makes them a tractable backlog.

## Stage 4 — Persist the evidence that is already computed

The cheapest explainability wins in the repository: the evidence is manufactured and then dropped at
the persistence boundary.

- `proxy/scheduler.ts` builds a `reason` for every action ("`X` needs memory; evicting idle `Y`",
  "exceeded idle unload threshold"), and `protocol-endpoint.ts:941` does
  `.map((action) => action.type)`, discarding `reason`, `instanceId`, `model` and `slotId`. Widen
  `ApiProxyRequestTraceSchema.schedulerActions` from `z.array(z.string())` to the full action shape
  and stop mapping. `trace_json` is an opaque blob, so no DB migration is needed; the web
  `TracesTable` rendering follows.
- `trace.errorCode` has a column, an index, a filter and a UI facet, and is assigned exactly twice —
  both `"client-abort"` — while ~15 structured `arriero_proxy_*` diagnostics are flattened into
  prose in `errorMessage`. Assign the code that already exists.
- Idle maintenance unloads instances on a timer and logs only on error, so an autonomous unload
  leaves no evidence anywhere. With stage 3 in place, log the scheduler's reason.
- Health-summary verdicts are recomputed per call and never stored. Log the reason on status
  transition. Do **not** add a history table yet — revisit only if the log proves insufficient.
- `process_runs` is pruned to the latest plus open run per instance on every start, which destroys
  crash-loop history and every earlier launch snapshot. Launch snapshots are valuable precisely
  because they are comparative ("it worked yesterday — what changed?"), and exactly one is kept.
  Keep the last N (start with 20) per instance, and add a `stopReason` column so an operator stop, a
  scheduler eviction, an idle unload and a crash stop being indistinguishable. Touches both
  `schema.ts` and `migrate()` — which is why stage 2's test lands first.

**Acceptance:** from stored data alone, answer "why was model B evicted rather than C", "why did
this instance stop", "has it crash-looped", and "why did my model unload while I was away".

## Stage 5 — Split `packages/core/src/index.ts`

4,220 lines, 268 `z.object` schemas, 729 exports, ≥19 domains, imported by 385 files, touched in 99
of the last 300 commits. It is the one file every change must open — for an agent that means
context bloat and constant conflict.

Strategy is what makes this safe: **`index.ts` becomes a pure barrel.** Extract one domain per
commit into `src/<domain>.ts` and re-export it, so none of the 385 consumers change. The package
already has nine sibling modules; this continues that pattern rather than inventing one.

Suggested order, largest first: `proxy` (92 exports), `llama` (29), `instance` (28), `system` (21),
`config` (19), `source` (16), `prerequisites` (15), `environment` (13), then `update`/`model`/`build`
(29 combined).

**Acceptance:** `index.ts` contains only re-exports; no consumer import changed; `pnpm check` green
after each individual commit.

**Risk:** low per slice, high if batched. One domain per commit, no exceptions.

## Stage 6 — Give pipeline nodes a descriptor

`engineDescriptor` is the proof that this project can do open-closed: `INSTANCE_KINDS` is declared
once and every dispatcher is an exhaustive `Record<…Id, Impl>`, so a new engine kind breaks
compilation in exactly two files, and `docs/ENGINE_ADAPTERS.md:92` names that exhaustiveness as the
to-do list.

Pipeline node types get none of it: **14 types are enumerated 15 times across 10 files, and only 3
enumerations are compiler-enforced — all three are label/colour maps.** The executor switch, the
route-trace enum, the `single-next` array, the record→draft switch, the field-editor `if` chain and
the type-picker array all fail silently. A new node type simply never appears in the picker.

- After stage 5 lands `core/src/proxy/pipeline-nodes.ts`, add `pipelineNodeDescriptor` mirroring
  `engineDescriptor`: label, colour, single-next-ness, field schema, draft mapping — one owner.
- Replace the 15 enumerations. Where a `Record` does not fit (the executor switch), add a `never`
  exhaustiveness check.
- Flatten `apps/web/src/ui/proxy/forms.ts`'s 52-field `PipelineNodeDraft` into per-node shapes.
- Two dispatchers on the engine side are `if`-chains rather than `Record`s and silently fall through
  to llama semantics — fix them in the same pass: `memory-estimate/service.ts:450-458` and
  `instance-resources.ts:440,508,512`.

**Acceptance:** adding a node type breaks compilation in exactly one file and the node appears in
the picker with no further edits.

**Risk:** highest in the plan — the pipeline editor has no tests. Write `route-explain`-driven tests
first, and verify the canvas with `pnpm browse` before and after.

## Later, not now

- knip's `duplicates` rule is currently `"off"` in `knip.json`, which is exactly duplicate-authority
  detection switched off. Turn it on after stage 5, when the split has removed the obvious noise.
- A second engine list, `EnvironmentEngineSchema = z.enum(["vllm","ktransformers"])`, sits in the
  same file as `InstanceKindSchema` and is not derived from `INSTANCE_KINDS`.
- The preset-name regex has three owners, and the web copy omits the length bound core enforces.
- Five mutually inconsistent job-status→colour maps (`succeeded` is teal in one view, green in four).
- Web smoke coverage: 36,825 lines behind zero tests. `pnpm browse` over the main routes is a better
  return than unit tests here.

## Non-goals

Event sourcing for stage 4 — not dropping the reasons already computed is enough. Full unit coverage
of the web layer. Hand-rewriting all 87 swallowed catches. Any change to
`docs/STATUS_LAYERS.md`, `docs/MIGRATIONS.md`, `docs/CASE_PHANTOM_HELP_ARGS.md` or
`docs/qualification/*` — those are the reference standard the rest should be raised toward, and the
four status layers in particular are documented as intentionally divergent precisely so a later
refactor does not "unify" them.

Preserve while refactoring: all 176 api test files use **zero mocks** — real tmpdirs, real SQLite,
real git repositories, injected clocks and ports. That is what makes them usable as a specification
for regenerating a module, and it is the property that keeps principle I alive here.
