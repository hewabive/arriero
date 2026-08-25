# Web UI

`apps/web` is a single-page React 19 + Vite application: Mantine 9 components, TanStack Query 5 for
server state, `@xyflow/react` for the pipeline canvas, hash routing with no router library. It
renders the admin surface for every API domain plus the public status page. This document maps the
shell and the cross-cutting plumbing; per-view logic lives with the view, and the always-loaded rules
are `apps/web/CLAUDE.md`.

## Shell and providers

`src/main.tsx` mounts, under `React.StrictMode`: `QueryClientProvider` (one default `QueryClient`) →
`NodeProvider` (node scoping, below) → `MantineProvider` (`defaultColorScheme="dark"` and
`deduplicateInlineStyles` for React 19 style hoisting; the `createTheme` owns the heading scale and
component-wide defaults such as `Tooltip` opening on
hover/focus/touch) → a root error boundary that renders a reload screen on any uncaught render error
→ `Notifications`. `src/styles.css` is the only global stylesheet — a small set of layout and
text-wrapping helpers on Mantine CSS variables; everything else styles through Mantine props.

StrictMode double-invokes effects in dev. An effect that fires a mutation or any one-shot action must
be guarded — `ui/utils/use-auto-update-check.ts` shows the `firedRef` pattern; an unguarded
mutate-in-effect has produced duplicate requests before.

## Rendering model

`src/ui/App.tsx` reads `useHashRoute`/`useHashSubpath` and renders exactly one view per route by
conditional; views unmount on navigation. The exception is `ApiLabView`, which after the first visit
stays mounted and hidden (`display: none`) so composed probes survive navigation.

`App.tsx` owns the cross-view state: the selected instance name, the launch monitor, and the two
`InstanceFormModal` mounts (create with an optional model seed; edit/duplicate). Views receive
callbacks — `onOpenDiagnostics`, `onEdit`, `onUseModel`, … — so any page can open the editor or jump
to Diagnostics with the selection preserved. App also derives the sidebar badges (running count,
error/stale and degraded dots, proxy failed-request dot) from its own polling queries.

## Routing and navigation

Everything after `#/` is `route[/subpath]`, parsed in `src/ui/routing.ts`. Unknown heads fall back to
`status`; retired heads are remapped by `legacyAlias` (`#/routing` → `#/proxy/pipelines`, …) so old
bookmarks survive renames — retire a route by adding an alias, not by letting it 404 into `status`.

`navSections` is the single source of the two-level navigation: the sidebar renders one row per
section (`manager` pinned to the bottom via `footer`), the section's leaves render as page tabs
(`SectionTabs`), and `CommandPalette` (Ctrl+K) is built from the same list, so a new leaf gets search
coverage through its `keywords` for free. `activeLeaf` matches route + first subpath segment and
falls back to the route-only leaf, so a deeper path like `#/args/vllm` still highlights its tab. The
route entry owns the page title and one-line description — `App.tsx` renders them once and sets
`document.title`.

The sidebar is audience-split by `sidebarSections(canUseAdmin)`: signed out it is exactly Public
status + Sign in, so a gated page always has a way back; signed in it is the admin sections without
Public status, which stays reachable at `#/status` and through the palette.

## Auth and gating

The admin session is a cookie; every fetch sends `credentials: "include"`. The `auth-state` query
polls every 30 s and tightens to 3 s while failing, which is also the recovery loop behind the
"API server unreachable" alert. `canUseAdmin` gates every admin query (`enabled:`) and every admin
view; hitting a gated route signed out renders `LoginView` inline, so the deep link survives the
sign-in, and once authenticated an empty or `login` hash redirects to `dashboard`. Logout invalidates
the auth state, removes the instance caches and routes to `status`.

## Data layer (`src/api/`)

One module per API domain; `client.ts` is the barrel the UI imports from. All request/response
shapes come from `@arriero/core` and are never redeclared. `http.ts:request` is the single fetch
wrapper: JSON in/out, non-OK responses become an `ApiError` carrying status and parsed body, with Zod
issue and `fieldErrors` bodies flattened to a readable message by `formatApiErrorValue`.
`buildQuery` drops undefined and empty params.

Every URL is built on `apiBase` (`base.ts`), derived at runtime from `window.location.pathname` —
this is what lets one `dist` serve at the domain root or behind any path prefix. A root-absolute
`/api` in a fetch breaks the subpath deploy (`docs/SUBPATH_DEPLOY.md`); `absoluteUrl` is for URLs
shown to the user.

## Node scoping (federation)

`base.ts` keeps a module-level active node id persisted in localStorage. `nodeRequest` wraps
`request` in `nodeScopedPath`, which rewrites `/api/...` to `/api/nodes/:id/...` for any node but
`self` (transport: `docs/FEDERATION.md`). Which helper an endpoint uses is the per-domain decision of
whether it follows the node switcher: domain data does; auth, the public status, the nodes registry
and the self version always target the local manager via plain `request`.

`NodeProvider` mirrors the id into React state, and a switch calls `queryClient.invalidateQueries()`
wholesale. Query keys therefore do not embed the node id — a new node-scoped query behaves correctly
on switch with no extra work, at the cost that two nodes' data never coexist in the cache. The
exception is `NodesView.tsx`, whose update-job and restart polling addresses an explicitly chosen
peer regardless of the active node and keys by that `nodeId`.

## Server state

Polling via `refetchInterval` is the default liveness mechanism (instances 2.5 s, health summaries
3 s, nav proxy stats 20 s, and ~50 more across the views). Mutations surface failures through
`notifications.show` — there is no global error handler; each mutation owns its message.

Three streams bypass polling. Instance runtime events (`InstanceDetails.tsx`) and the system-metrics
live stream (`use-system-metrics.ts`) use `EventSource` with URLs built through `apiBase` +
`activeNodeScopedPath`, so they follow both the subpath and the node scope. The api-lab probe stream
is a POST, which `EventSource` cannot express: `api/sse.ts:readApiProbeStream` parses SSE blocks off
a fetch body instead.

## UI version guard

`vite.config.ts` bakes the git commit into `__ARRIERO_UI_COMMIT__` at build time.
`use-ui-version-guard.tsx` compares it against the server's build commit every 10 minutes and on
window focus (60 s minimum gap); a mismatch shows a persistent "UI is out of date" notification once
per commit pair per tab session, whose button runs `forceReloadUi` — a `cache: "reload"` refetch of
the document, then a reload. Disabled in dev and when the baked commit is unknown.

## Dev and prod serving

`pnpm dev` runs Vite on :5173 proxying `/api`, `/proxy` and `/v1` to the api on :8787; a local plugin
adds `packages/*/src` to the watcher so workspace-package edits hot-reload (the `development` exports
condition resolving them to `src` is a Vite dev default — root `CLAUDE.md`). In prod the api serves
the built `dist`; `base: "./"` keeps asset references relative for subpath mounts.

## Verification

The workspace has no test suite — its `check` script is `tsc --noEmit`. Correctness rides on the root
gate (`pnpm check:events` for the event-capture trap, knip, format) and on visual verification:
`pnpm browse` drives the running UI headlessly (the `browse` skill).
