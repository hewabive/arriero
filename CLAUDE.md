# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository. **This file holds only what is true
everywhere.** Rules for one part of the tree live in a nested `CLAUDE.md` inside it, loaded when you
open files there; explanation and detail live in `docs/`, indexed by `docs/README.md`. Read the zone
file before changing code in that zone.

## Overview

`arriero` is a single-operator control plane for `llama.cpp` / `llama-server`, vLLM, SGLang and
KTransformers: it manages instance definitions, supervises child processes, scans GGUF models, builds
llama.cpp from source, documents engine arguments, and exposes an OpenAI/Anthropic-compatible API
proxy in front of managed and external endpoints. One host is the default; the `nodes` domain extends
the same UI over a fleet of peers (`docs/FEDERATION.md`).

## Commands

```bash
pnpm dev     # build core, then api (tsx watch) + web (vite) in parallel — api :8787, web :5173
pnpm build   # build all workspaces
pnpm serve   # build, then api alone serving the built web UI — single process, one port
pnpm check   # THE gate — see below
pnpm format  # prettier --write .   (format:check reports instead of writing)
pnpm browse  # drive the running UI headlessly to verify a change — the `browse` skill
```

- **`pnpm check` is the gate — run it before every commit**, and it is the only command that has to
  pass. It chains: react event captures → no-comments → NUL bytes → doc claims → `.env.example` →
  format → build core + bridge → per-workspace `tsc --noEmit` → knip → argument-doc quality → every
  test suite. Each stage also runs standalone under the same name (`pnpm check:events`, …).
  `pnpm check:sources` is deliberately outside the gate: it needs machine state (a llama.cpp
  checkout, sibling update-kit repos) that a fresh clone does not have, and each of its checks exits
  non-zero when that input is missing rather than reporting a silent pass. `pnpm check:silent-catch`
  is an advisory inventory of catches that swallow without a trace.
- **Docs-only exception**: when the diff touches nothing but `*.md` and `content/`, the gate narrows
  to `pnpm check:docs && pnpm format:check && pnpm --filter @arriero/api args:docs:quality` — the
  rest of `check` provably never reads those files (prettier ignores `*.md`, no test reads
  `content/`). Any other file in the diff ⇒ full `pnpm check`.
- In dev the `development` exports condition resolves `@arriero/core` and
  `@arriero/anthropic-openai-bridge` straight to `src` (api: `tsx watch --conditions=development`,
  reaching worker threads too; web: a Vite dev default) — `packages/*` edits apply live with no
  manual rebuild. `dist` stays the artifact for prod (`serve` / `start`) and api tests.
- Running tests, including a single file: `apps/api/CLAUDE.md`.

## Zones

pnpm workspace, Node 24+, ESM throughout. **Relative imports use `.js` extensions** (NodeNext
resolution) even though the sources are `.ts`.

| Zone | What it is | Zone file |
| --- | --- | --- |
| `packages/core` | the contract layer — Zod schemas shared by api and web; a new shape is added here first | `packages/core/CLAUDE.md` |
| `packages/anthropic-openai-bridge` | sans-IO Anthropic ↔ OpenAI translation, kept extraction-ready | `packages/anthropic-openai-bridge/CLAUDE.md` |
| `apps/api` | Hono server, SQLite via Drizzle, one directory per domain | `apps/api/CLAUDE.md` |
| `apps/api/src/proxy` | the API proxy: scheduling, pipelines, streams, translation | `apps/api/src/proxy/CLAUDE.md` |
| `apps/api/src/process` | supervision of managed engine processes | `apps/api/src/process/CLAUDE.md` |
| `apps/web` | React 19 + Vite + Mantine UI | `apps/web/CLAUDE.md` |
| `content` | Russian engineering help for engine arguments | `content/CLAUDE.md` |
| `docs` | all explanatory depth, grouped by subject | `docs/README.md` |

Portable file-backed configuration: `docs/CONFIG_FILES.md`. Machine-local state (`data/`, `runtime/`)
and every `ARRIERO_*` variable: `docs/RUNTIME_LAYOUT.md`.

## Conventions

- **Reply to the user in Russian.** Code, identifiers, commit messages and docs stay in English.
- **Never create git branches unless asked** — commit to the current branch (on `main`, commit to
  `main`).
- **No code comments — categorical.** Do not write comments in source code (no `//`, `/* */`, JSDoc,
  or block banners). Code must be self-documenting: express intent through clear names, small
  functions, and types. If something genuinely needs explanation (non-obvious rationale, design
  constraints, gotchas), put it in a document under `docs/` and reference that document from the
  surrounding documentation of the relevant code path — never inline. This overrides any default
  tendency to add explanatory comments. Enforced by `scripts/check-no-comments.mjs`, which reads
  comment trivia through the TypeScript parser — so `//` inside a string or template literal is not a
  comment — and allows only machine-readable pragmas (`@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `eslint-disable`, `prettier-ignore`, `@deprecated`, `#!`).
- **A swallowed error must leave a trace.** A `catch` that neither rethrows nor returns a typed
  failure has to log via the shared `logger` (`apps/api/src/logger.ts` — the one place `pino` is
  constructed; background loops still prefer an injected `onError`). Unknown is an acceptable result,
  silently substituting a plausible value for it is not: prefer `null` plus a caller-side guard over
  `?? 0` / `?? []` when the real answer is "not measured".
- **Documentation has an altitude for every fact.** This file: rules true everywhere. A nested
  `CLAUDE.md`: what you must know to write code in that directory, kept short because it loads whole.
  `docs/*.md`: rationale and detail, read on demand. Never restate a document inside a `CLAUDE.md` —
  state the rule and link it. Prefer tightening an existing line over appending a new one, and delete
  what went stale.
- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index
  access yields `T | undefined`, and optional properties must be omitted rather than set to
  `undefined`.
- Realtime: prefer SSE (Hono `streamSSE`); WebSocket only for bidirectional terminal-like control.
