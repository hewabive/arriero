# Argument Help Workflow

Engineering help for `llama-server` arguments lives in `content/llama-args/llama-server/*.md`.

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

The stored hash is the only automatic stale signal. Individual Markdown files do not carry review statuses or per-file reviewed hashes.

## User Signal

The `Arguments` page compares the stored snapshot hash with the current generated help block from the configured source repo.

- Hash matches: no action.
- Hash differs: show one global warning that the argument reference may not match the current llama.cpp source.
- Missing source/snapshot: show a source-sync error.

The app does not mark individual argument docs as needing review when llama.cpp gets a new commit.

## Agent Workflow

This document is the source of truth. The repo-local skills are thin wrappers that point here:

```text
.claude/skills/llama-arg-help-sync/SKILL.md   # Claude Code
.codex/skills/llama-arg-help-sync/SKILL.md    # Codex
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
2. Verify each added/changed row against the actual source, not just the README. The generated help block can run ahead of the code: a doc-regeneration commit can add rows to `tools/server/README.md` without a matching `common/arg.cpp` change, so the row describes a flag the built binary does not accept (a "phantom" arg). Cross-check with the configured llama.cpp checkout — grep `common/arg.cpp` and the `LLAMA_ARG_*` env name — and, when a build exists, the built `llama-server --help`. See `docs/CASE_PHANTOM_HELP_ARGS.md`.
3. For each affected argument, edit the matching file in `content/llama-args/llama-server/*.md`. Then grep `content/llama-args/llama-server/` for mentions of each changed argument and fix cross-references in other docs whose claims the change invalidated — this is targeted repair, not a mass-edit.
4. For a new argument, create a focused Russian Engineering help file using nearby argument docs as the style reference: practical behavior, safe defaults, interactions, diagnostics, and relevant source/issue links. To find the upstream PR behind an added or changed help row, run `git log -S "<new help text>" --oneline -- common/arg.cpp` in the configured llama.cpp checkout. Every doc must declare a frontmatter `estimation` class (`args:docs:quality` fails without it) — it feeds the memory-estimator gate (`apps/api/src/arguments/estimation.ts`): `normal` (estimable), `exits` (prints and exits before loading a model), `preset-rewrite` (built-in preset that rewrites launch arguments inside llama.cpp), `remote-selector` / `remote-mmproj` / `remote-draft` (fetches the main/mmproj/draft artifact remotely), `router` (loads a changing set of child models). Deciding this class for each new argument is part of writing its doc: a misclassified `normal` preset produces confidently wrong memory estimates.
5. For a phantom arg (in the README help block but not in the source/binary), still write a doc, but add a `Статус в upstream` section: state it is not implemented in the current checkout, link the PR that introduced the README row, and note it will not appear in the arriero catalog (built from `--help`) until the feature lands. Do not present it as a working flag.
6. For a removed argument, delete the matching doc only after confirming it was not renamed or moved.
7. Once the docs match the new generated help, write the snapshot/hash with `--write`. Sync only
   against the checkout's own master state: verify claims in the configured checkout as it stands,
   never against an unmerged upstream branch or out-of-band (web) content — that records a
   `llamaCppCommit` unreachable from the checkout and documents behavior the built binary does not
   have (this happened with `--repeat-last-n`/`--dry-penalty-last-n`, fixed in 1adc2ba).

Do not add `docStatus`, `reviewedLlamaCppCommit`, or `reviewedHelpHash` to docs. The stored source snapshot hash is the only synchronization signal.

## Hygiene Rules

- Do not commit generated work-order text.
- Useful permanent changes belong in argument Markdown files, the source snapshot, or app code.
- If scratch notes are unavoidable, put them under `runtime/tmp/argument-help/`, start the file with `TEMPORARY - remove after task`, and delete it before final verification.
- Do not mass-edit all argument docs just because the llama.cpp commit changed.

## Completion Criteria

- The generated help diff has been reviewed.
- Affected docs are updated.
- Docs for removed arguments are deleted, not kept with a legacy status.
- `args:docs:source-sync` reports `"inSync": true`.
- `args:docs:quality` passes.
