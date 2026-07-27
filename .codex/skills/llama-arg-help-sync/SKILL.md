---
name: llama-arg-help-sync
description: Use when arriero reports that the stored llama-server generated help snapshot differs from the configured llama.cpp tools/server/README.md help block, and Engineering help in content/llama-args/llama-server needs to be refreshed.
metadata:
  short-description: Sync llama-server argument Engineering help
---

# llama-server Argument Help Sync

Follow the full procedure in `docs/ARGUMENT_HELP_WORKFLOW.md` — it is the single source of truth for this task. Read it before making changes.

In short: review the generated help diff, edit only the affected Engineering help files under `content/llama-args/llama-server/`, then write the new snapshot/hash and validate.

```bash
pnpm --filter @arriero/api args:docs:source-sync -- --diff
pnpm --filter @arriero/api args:docs:source-sync -- --write
pnpm --filter @arriero/api args:docs:quality
pnpm --filter @arriero/api args:docs:source-sync   # expect "inSync": true
```
