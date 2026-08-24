# CLAUDE.md — content/ (engine argument documentation)

Russian "Engineering help" for engine arguments. **The update procedure for every engine lives in
`docs/ARGUMENT_HELP_WORKFLOW.md`** — one step list for llama.cpp, one for the Python engines
(estimation and phantom rows are llama-only). The repo-local skills `.claude/skills/arg-help-sync`
and `.codex/skills/arg-help-sync` are thin wrappers over that document. Maintenance CLIs (api
package): `args:docs:source-sync` (compare / `--diff` / `--write` the generated help snapshot) and
`args:docs:quality`.

## Two layouts, two registries

- `llama-args/llama-server/*.md` — **the doc files are the registry** (`arguments/registry.ts`).
  Frontmatter carries the full argument surface. The sync source of truth is the
  `HELP_START`/`HELP_END` block in the configured llama.cpp checkout's `tools/server/README.md`,
  snapshotted into `llama-args/source/`. Only the stored snapshot hash is an automatic stale signal —
  individual doc files are not marked stale per commit.
- `engine-args/<engine>/args/<slug>.md` — **docs add prose only**. The committed declaration extract
  owns flags, group, choices and default, so frontmatter carries just `schema` / `engine` /
  `primaryName` / `title` / `summary` / `group` / `related`. Per-engine authoring contract:
  `engine-args/<engine>/_agent-prompt.md`.

## Where the Python-engine surface comes from

vLLM and SGLang publish no help block, so the sync source is a **declaration extract** read from the
checkout by stdlib-`ast` scripts (`scripts/extract-args/vllm.py`, `scripts/extract-args/sglang.py`) —
no venv, no engine import, no GPU. One `help-source` adapter per engine
(`arguments/help-source-adapters.ts`, CLI `args:docs:source-sync -- --engine <id>`,
`GET /api/engine-args/help-sources`) snapshots it under `engine-args/<engine>/source/`; the stored
hash covers the argument surface only (`origin` excluded), and an unavailable extractor degrades to a
git commit-range signal instead of a fake in-sync.

The committed extract doubles as the **reference catalog**: `arguments/engine-reference.ts` maps it to
`ArgumentOption[]` (`GET /api/engine-args/:engineId/reference`), attaches the Russian help and serves
it at `#/args/<engine>` — the llama Arguments page reused with the llama sync panel switched off.
Instance defaults save into the per-engine `engines.<id>` section of `argument-defaults.json`.
Contract and measured coverage: `docs/ARGUMENT_SOURCE_EXTRACTION.md`.

## The one structural default channel

`ArgumentOption.defaultValue`: llama help parsing derives it from the `(default: …)` convention, the
python reference maps the extract's literal `default`, and catalog read boundaries backfill it from
stored help (`fillMissingDefaultValues`) so pre-field rows and sidecars need no regeneration.
Consumers (`arguments/binary-defaults.ts`, the estimators) read the field, **never** the prose.
