# Argument Help Workflow

Engineering help for engine arguments lives in `content/llama-args/llama-server/*.md` (llama.cpp) and
`content/engine-args/<engine>/args/*.md` (vLLM, SGLang/KTransformers).

One workflow, two readers. llama.cpp syncs against the generated help block its upstream publishes;
the Python engines publish no such block, so they sync against a declaration extract read from the
checkout — described in `docs/ARGUMENT_SOURCE_EXTRACTION.md`, driven by
`args:docs:source-sync -- --engine <id>`. Snapshot, hash, diff and the `--write`-is-the-only-writer
rule are identical. The per-engine step lists below are not: phantom help rows and the `estimation`
frontmatter class are llama-only, and the engines have a per-engine authoring contract instead.

## Source Of Truth

The synchronization source is the generated help block in the configured `llama.cpp` checkout:

```text
tools/server/README.md
<!-- HELP_START --> ... <!-- HELP_END -->
```

arriero stores a reviewed snapshot of that block in:

```text
content/llama-args/source/server-help.generated.md
content/llama-args/source/help-source.json
```

For the Python engines the same role is played by the declaration extract, snapshotted under
`content/engine-args/<engine>/source/` as `extract.json` plus `help-source.json`. The stored hash
covers the argument surface only (`origin` is excluded), so moving a declaration between files is not
drift while adding a choice is.

The stored hash is the only automatic stale signal. Individual Markdown files do not carry review statuses or per-file reviewed hashes.

## User Signal

The `Arguments` page compares the stored snapshot hash with the current generated help block from the configured source repo.

- Hash matches: no action.
- Hash differs: show one global warning that the argument reference may not match the current llama.cpp source.
- Missing source/snapshot: show a source-sync error.

The app does not mark individual argument docs as needing review when llama.cpp gets a new commit.

For the Python engines the signal surfaces on the Source sync page (`#/source-sync`) instead, one
help-source row per adapter inside its repository's panel: status badge, snapshot vs checkout commit,
signal, pending commits and an on-demand diff. That page is read-only — writing a snapshot stays a
CLI action.

## Agent Workflow — llama.cpp

This document is the source of truth. The repo-local skills are thin wrappers that point here, and
cover every engine:

```text
.claude/skills/arg-help-sync/SKILL.md   # Claude Code
.codex/skills/arg-help-sync/SKILL.md    # Codex
```

Useful commands:

```bash
pnpm --filter @arriero/api args:docs:source-sync
pnpm --filter @arriero/api args:docs:source-sync -- --diff
pnpm --filter @arriero/api args:docs:source-sync -- --write
pnpm --filter @arriero/api args:docs:quality
```

Steps:

1. Review the generated help diff (`--diff`). Identify only the arguments whose table rows were added, removed, or changed — do not review every argument just because the llama.cpp commit changed.
2. Verify each added/changed row against the actual source, not just the README. The generated help block can run ahead of the code: a doc-regeneration commit can add rows to `tools/server/README.md` without a matching `common/arg.cpp` change, so the row describes a flag the built binary does not accept (a "phantom" arg). The plain `args:docs:source-sync` report lists rows whose flags appear nowhere in the checkout's `common/arg.cpp` as `phantomRows` — treat a non-empty list as the phantom procedure trigger (step 5). The check is literal, so it cannot see per-example gating (`set_examples`); for a row that looks server-inapplicable, confirm against the built `llama-server --help`. See `docs/CASE_PHANTOM_HELP_ARGS.md`.
3. For each affected argument, edit the matching file in `content/llama-args/llama-server/*.md`. Then grep `content/llama-args/llama-server/` for mentions of each changed argument and fix cross-references in other docs whose claims the change invalidated — this is targeted repair, not a mass-edit.
4. For a new argument, create a focused Russian Engineering help file using nearby argument docs as the style reference: practical behavior, safe defaults, interactions, diagnostics, and relevant source/issue links. To find the upstream PR behind an added or changed help row, run `git log -S "<new help text>" --oneline -- common/arg.cpp` in the configured llama.cpp checkout. Every doc must declare a frontmatter `estimation` class (`args:docs:quality` fails without it) — it feeds the memory-estimator gate (`apps/api/src/arguments/estimation.ts`): `normal` (estimable), `exits` (prints and exits before loading a model), `preset-rewrite` (built-in preset that rewrites launch arguments inside llama.cpp), `remote-selector` / `remote-mmproj` / `remote-draft` (fetches the main/mmproj/draft artifact remotely), `router` (loads a changing set of child models). Deciding this class for each new argument is part of writing its doc: a misclassified `normal` preset produces confidently wrong memory estimates.
5. For a phantom arg (in the README help block but not in the source/binary), still write a doc, but add a `Статус в upstream` section: state it is not implemented in the current checkout, link the PR that introduced the README row, and note it will not appear in the arriero catalog (built from `--help`) until the feature lands. Do not present it as a working flag.
6. For a removed argument, delete the matching doc only after confirming it was not renamed or moved.
7. Once the docs match the new generated help, write the snapshot/hash with `--write`. Sync only
   against the checkout's own master state: verify claims in the configured checkout as it stands,
   never against an unmerged upstream branch or out-of-band (web) content — that documents behavior
   the built binary does not have (this happened with `--repeat-last-n`/`--dry-penalty-last-n`,
   fixed in 1adc2ba). Never hand-author the snapshot/metadata files — `--write` is the only writer;
   a stored `llamaCppCommit` unreachable from the checkout HEAD is reported as a `stored.error` by
   `args:docs:source-sync` and blocks the completion criteria.

Do not add `docStatus`, `reviewedLlamaCppCommit`, or `reviewedHelpHash` to docs. The stored source snapshot hash is the only synchronization signal.

## Agent Workflow — Python Engines

Same shape, different reader and different rules.

```bash
pnpm --filter @arriero/api args:docs:source-sync -- --engine <id>
pnpm --filter @arriero/api args:docs:source-sync -- --engine <id> --diff
pnpm --filter @arriero/api args:docs:source-sync -- --engine <id> --write
```

Steps:

1. Review the diff (`--diff`). It is already reduced to the argument surface — `+ flag`, `- flag`, `~ flag` with the changed fields — so work only those entries. A report whose `signal` is `commit-range` with `"inSync": null` is **not** a pass: the extractor could not run (no python3, no checkout, upstream refactor tripping a structural assert). Fix that before editing anything, or you are documenting against a stale snapshot.
2. Read the current extract before editing. `## Оригинальная справка` has to match the entry's `help` character for character, and `--write` has not run yet, so generate the new one to a scratch path: `python3 scripts/extract-args/<engine>.py --repo runtime/sources/<engine> --out <scratch>.json`.
3. Verify every changed entry against the checkout source, not the extract alone. The extract is a *declaration* of one commit; the argument catalog is still `--help` of the **installed** engine, so an argument can exist in the extract and not in the installed package — the same phenomenon as `docs/CASE_PHANTOM_HELP_ARGS.md`. Describe behaviour from the checkout and never assert "available in your build". The entry's `origin` points at the declaration; for SGLang the effective value is usually rewritten afterwards in `ServerArgs.__post_init__` / the `_handle_*` methods, and that rewrite is the part worth documenting. To find the upstream PR behind a change, run `git log -S "<new help text>"` over the engine's declaration paths in the checkout.
4. Edit the matching `content/engine-args/<engine>/args/<slug>.md`, then grep that engine's `args/` directory for the changed flag and repair cross-references whose claims the change invalidated — targeted repair, not a mass-edit. A changed default invalidates neighbours most often, because other docs state it as background fact.
5. For a new argument, write the doc per `content/engine-args/<engine>/_agent-prompt.md` — the per-engine authoring contract covering structure, sections, style and `## Источники` conventions. Frontmatter is fixed and has **no `estimation` key**: that class is llama-only and the lint rejects it here.
6. For an argument whose help became `Deprecated. Use --x instead.`, rewrite the doc as a deprecation doc — do not delete it, and do not leave the superseded mechanism described as current. The flag still parses, but its old machinery is often gone from the code entirely, so state what replaced it and where the translation happens (`_handle_deprecated_args` for SGLang). Delete a doc only once the argument is absent from the extract.
7. Once the docs match the new extract, write the snapshot with `--write`. Never hand-author the snapshot or metadata files.

## Engine Doc Frontmatter And Lint

`args:docs:quality` lints both trees; the engine rules live in `apps/api/src/arguments/docs-quality-lint.ts`.

Frontmatter is fixed — no other keys:

```yaml
---
schema: 1
engine: vllm
primaryName: "--max-model-len"
title: "--max-model-len"
summary: Russian, one or two practical sentences.
group: ModelConfig
related:
  - --max-num-seqs
---
```

Errors:

- a required field missing or empty: `schema`, `engine`, `primaryName`, `title`, `summary`, `related` (an empty list is allowed);
- an `estimation`, `valueType`, `aliases`, `allowedValues` or `env` key — that data lives in the extract and is never copied into a doc;
- an `engine` other than the directory the file sits in;
- a `primaryName` that is not the first flag of an extract entry, i.e. a doc for an argument that no longer exists;
- a file name other than the `argumentDocSlug` of `primaryName` plus `.md` (`apps/api/src/arguments/docs.ts`);
- a `group` other than the extract's; absent or `null` exactly when the extract declares none;
- a `related` flag absent from the same engine's extract (matched against every flag of an entry, not only the first), or pointing at the documented argument itself;
- the same stale template text llama docs are checked for (`TODO`, "нужно проверить", "создан автоматически", …).

Warning: the first sentence of the extract's `help` appears nowhere in the file — the doc was written without reading the declaration.

Coverage is reported per engine in the `engines` field of the report (`documented` of `total` arguments). An absent or empty `args/` directory is a clean pass: most arguments have no doc yet.

## Hygiene Rules

- Do not commit generated work-order text.
- Useful permanent changes belong in argument Markdown files, the source snapshot, or app code.
- If scratch notes are unavoidable, put them under `runtime/tmp/argument-help/`, start the file with `TEMPORARY - remove after task`, and delete it before final verification.
- Do not mass-edit all argument docs just because the llama.cpp commit changed.

## Completion Criteria

- The source diff has been reviewed.
- Affected docs are updated.
- Docs for removed arguments are deleted, not kept with a legacy status. An argument that still parses but is marked deprecated upstream is not a removed argument — it keeps a rewritten doc.
- `args:docs:source-sync` reports `"inSync": true` for the engine you touched — with `--engine <id>` for the Python engines, bare for llama.cpp. `"inSync": null` is a failure, not a pass.
- `args:docs:quality` passes.
- Commit gate: a sync commit normally touches only `content/` and `*.md`, so the docs-only fast
  gate from CLAUDE.md applies (`pnpm check:docs && pnpm format:check && pnpm --filter @arriero/api
  args:docs:quality`); any other file in the diff means full `pnpm check`.
