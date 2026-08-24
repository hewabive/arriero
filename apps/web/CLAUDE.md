# CLAUDE.md — @arriero/web

React 19 + Vite + Mantine UI; server state via TanStack Query; `@xyflow/react` powers the Routing
pipeline canvas (`src/ui/proxy/canvas/`). The architecture — shell, hash routing, data layer, node
scoping, streams, version guard — is `docs/WEB.md`; read it before structural changes.

- `src/ui/views/*` are the top-level pages; `src/api/` is the typed fetch layer (`http.ts` +
  `base.ts` do the work, `client.ts` re-exports). All request/response shapes come from
  `@arriero/core` — never redeclare them here.
- Every network call goes through the `src/api` helpers on `apiBase` (`request` / `nodeRequest` /
  `absoluteUrl`): a hardcoded root-absolute `/api` breaks the subpath deploy, and a raw `fetch`
  skips the active-node scope.
- **A new page is a leaf in an existing `navSections` section (`src/ui/routing.ts`), never a new
  sidebar row.** The route entry owns the page title and one-line description — a view never repeats
  them — and the leaf's `keywords` feed the Ctrl+K palette.
- Titles and labels are sentence case, acronyms kept ("API endpoints", "GGUF files"). Card headers
  are `Title order={4}`, page-level section headers `order={3}`. Counted labels go through
  `ui/utils/plural.ts:countLabel`, never hand-written `N items` / `N item(s)`.
- Mantine component-wide defaults belong in the `createTheme` in `src/main.tsx` — do not set
  per-usage props for behaviour every usage should share.
- `pnpm check:events` (part of `pnpm check`) fails the build if `event.currentTarget` /
  `event.target` from an outer handler is referenced inside a nested callback (setState updater,
  timer, promise). Read the value into a local first.
- StrictMode double-runs effects in dev — guard one-shot effect actions
  (`ui/utils/use-auto-update-check.ts` shows the pattern).
- Verify visually with `pnpm browse <cmd>` — the `browse` skill in `.claude/skills/browse/`.
