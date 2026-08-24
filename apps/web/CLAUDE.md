# CLAUDE.md — @arriero/web

React 19 + Vite + Mantine UI. Server state via TanStack Query; `@xyflow/react` powers the Routing
pipeline canvas (`src/ui/proxy/canvas/`). `src/ui/views/*` are the top-level pages; `src/api/` is the
typed fetch layer (`http.ts` + `base.ts` do the work, `client.ts` re-exports). All request/response
shapes come from `@arriero/core` — never redeclare them here.

## Navigation

Two-level and fully owned by `navSections` in `src/ui/routing.ts`: the sidebar renders one row per
**section** (`AppNav`, `manager` pinned to the bottom via `footer`), and the section's leaves render
as page tabs (`SectionTabs`) under the header. **A new page is a leaf in an existing section, never a
new sidebar row.** Hash routes are unaffected by grouping (a section may span several routes);
`activeLeaf` resolves the current leaf, falling back to the route-only leaf so `#/args/vllm` stays on
the Arguments tab. `Ctrl+K` opens `CommandPalette`, built from the same `navSections` — new leaves get
search coverage for free via `keywords`.

The sidebar is audience-split by `sidebarSections(canUseAdmin)`: signed out it is exactly **Public
status + Sign in** (so a gated page always has a way back); signed in it is the admin sections
**without** Public status, which stays reachable at `#/status` and through the palette. `#/login`
renders `LoginView`; hitting a gated route while signed out still renders it inline, so the deep link
survives the sign-in.

## Page chrome and copy

- The page title and its one-line description are owned by the route entry in `src/ui/routing.ts` and
  rendered by `App.tsx` — a view never repeats them.
- Titles and labels are sentence case, acronyms kept ("API endpoints", "GGUF files"). Card headers are
  `Title order={4}`, page-level section headers `order={3}`.
- Counted labels go through `ui/utils/plural.ts:countLabel`, never hand-written `N items` /
  `N item(s)`.
- Mantine component-wide defaults belong in the `createTheme` in `src/main.tsx` (e.g. `Tooltip` opens
  on hover/focus/touch so tooltips work on mobile; the heading scale lives there too) — do not set
  per-usage props for behaviour every usage should share.

## Event captures

`pnpm check:events` (part of `pnpm check`) fails the build if `event.currentTarget` / `event.target`
from an outer handler is referenced inside a nested callback (setState updater, timer, promise). Read
the value into a local first.

## Verifying visually

`pnpm browse <cmd>` drives the running UI through headless Playwright — see the `browse` skill in
`.claude/skills/browse/`.
