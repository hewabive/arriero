---
name: arg-help-sync
description: Use when arriero reports that a stored argument-help snapshot differs from its engine checkout — llama.cpp generated help, or the vLLM / SGLang declaration extract — and the Russian Engineering help needs refreshing.
metadata:
  short-description: Sync engine argument Engineering help
---

# Argument Help Sync

Follow the full procedure in `docs/ARGUMENT_HELP_WORKFLOW.md` — it is the single source of truth for this task. Read it before making changes.

It carries two step lists, and they differ: llama.cpp has phantom help rows and a required `estimation` frontmatter class, while the Python engines have neither (`estimation` is rejected by the lint there) and instead follow a per-engine authoring contract at `content/engine-args/<engine>/_agent-prompt.md`. Read the list for the engine you are syncing, not the other one.

In short: review the source diff, edit only the affected Engineering help files, then write the new snapshot/hash and validate.

```bash
# llama.cpp — content/llama-args/llama-server/*.md (no --engine keeps the llama-only behaviour)
pnpm --filter @arriero/api args:docs:source-sync -- --diff
pnpm --filter @arriero/api args:docs:source-sync -- --write

# vLLM / SGLang — content/engine-args/<engine>/args/*.md
pnpm --filter @arriero/api args:docs:source-sync -- --engine <id> --diff
pnpm --filter @arriero/api args:docs:source-sync -- --engine <id> --write

pnpm --filter @arriero/api args:docs:quality
```

Then re-run the plain report for the engine you touched and expect `"inSync": true`.
