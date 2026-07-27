---
name: browse
description: "Navigate the running arriero web UI via Playwright — visit hash routes, interact with the UI, take screenshots. USE WHEN asked to look at a page, check UI, visit a route, inspect the app visually, or interact with the running site."
argument-hint: "<#/route> | open | act ..."
allowed-tools: Bash, Read
---

Drive the running arriero web UI through a headless Playwright browser: navigate hash routes, take screenshots, interact with UI elements. No authentication step — admin auth is off by default in local dev.

## Prerequisites

- Web UI must be running. If not, ask the user to start it with `! pnpm dev` (web on `http://127.0.0.1:5173`, api on `:8787`).
- First-ever run needs the Chromium binary: `pnpm exec playwright install chromium` (one-time).
- Base URL defaults to `http://127.0.0.1:5173`. Override with the `BROWSE_URL` env var.

## Invocation

Always invoke as `pnpm browse <command> …` (no `--` after `browse`). Do **not** use `node --run browse` — it re-shells positional args and mangles selectors containing `()` (e.g. `:has-text('...')`); and `pnpm browse -- …` passes a literal `--` as the command and just prints usage. The direct form `node --experimental-strip-types --no-warnings scripts/browse.ts <command> …` also works if `pnpm` is unavailable.

## Routes

The UI is hash-routed (`#/<id>`); the default route (`/` or `#/`) is `status`. Available routes:

| Route           | Page                                         |
| --------------- | -------------------------------------------- |
| `#/status`      | Public Status (redacted diagnostics)         |
| `#/instances`   | Instances — process control for llama-server |
| `#/diagnostics` | Diagnostics — runtime state, probes, logs    |
| `#/args`        | Arguments reference                          |
| `#/paths`       | Path Catalog (binary paths)                  |
| `#/endpoints`   | API Endpoints                                |
| `#/proxy`       | API Proxy                                    |
| `#/api-lab`     | API Lab                                      |
| `#/models`      | Models (GGUF scan)                           |
| `#/presets`     | Presets                                      |
| `#/build`       | Build llama.cpp                              |
| `#/processes`   | System processes                             |

## Persistent browser (recommended)

Start a persistent browser to preserve page state (drawers, modals, forms) between commands:

```bash
pnpm browse open            # desktop viewport
pnpm browse open --mobile   # iPhone 14: 390×844, touch, mobile UA
```

The persistent browser runs as a background daemon. Subsequent `goto`/`screenshot`/`act` commands use it automatically. Stop with:

```bash
pnpm browse close
```

**Key benefit:** `act` interacts with the current page without re-navigating:

```bash
pnpm browse act --click "button:has-text('Create')"
pnpm browse act --fill "input[name='alias']" "my-instance" --shot
pnpm browse act --click ".mantine-Drawer-close" --wait 300
```

Without a persistent browser, each command launches a fresh browser (fallback — slower, no state).

## Commands

### Navigate and screenshot

```bash
pnpm browse goto /#/instances
pnpm browse goto /#/proxy
pnpm browse goto /#/build --mobile   # mobile viewport (fallback mode)
```

After `goto`, **read the screenshot** to see the page:

```
Read tmp/screenshots/browse.png
```

### Navigate with interactions

Chain actions on the same page load using the action flags below:

```bash
pnpm browse goto /#/instances --click "button:has-text('Create')"
pnpm browse goto /#/proxy --click ".tab-routes" --shot --wait 500 --shot
```

### Act on current page (persistent browser only)

```bash
pnpm browse act --click ".close-btn"
pnpm browse act --fill "#search" "qwen" --press "Enter"
```

### Screenshot last page

```bash
pnpm browse screenshot
```

With a persistent browser: screenshots the current page as-is. Without: re-navigates to the last URL and screenshots.

## Action flags (for `goto` and `act`)

| Flag       | Args                 | Effect                                      |
| ---------- | -------------------- | ------------------------------------------- |
| `--click`  | `<selector>`         | Click element, wait for network idle        |
| `--fill`   | `<selector> <value>` | Fill input/textarea                         |
| `--hover`  | `<selector>`         | Hover (tooltips, dropdowns)                 |
| `--press`  | `<key>`              | Press a key (`Escape`, `Enter`, `Tab`, …)   |
| `--select` | `<selector> <value>` | Select an `<option>`                        |
| `--shot`   | —                    | Intermediate screenshot (`browse-1.png`, …) |
| `--wait`   | `<ms>`               | Wait N milliseconds                         |

Actions run sequentially in the order given. The final screenshot is always `tmp/screenshots/browse.png`.

## Selectors

Playwright selectors:

| Pattern        | Example                                            | Notes                 |
| -------------- | -------------------------------------------------- | --------------------- |
| CSS            | `#alias`, `.btn-primary`, `input[name="port"]`     |                       |
| Text (partial) | `button:has-text('Create')`, `a:has-text('Proxy')` | Scope to element type |
| Role           | `role=button[name="Save"]`                         |                       |
| Chained        | `.mantine-Drawer-body >> button:has-text('Save')`  |                       |

## Workflow (persistent browser)

1. `pnpm browse open`
2. `pnpm browse goto /#/instances`
3. `Read tmp/screenshots/browse.png`
4. `pnpm browse act --click "..."`
5. `Read tmp/screenshots/browse.png`
6. Repeat; `pnpm browse close` when done.

## Selector gotchas (Mantine UI)

- **Strict mode**: `text=Foo` matches ALL elements containing "Foo"; multiple matches → error. Scope to element type: `button:has-text('Foo')`, or to a container.
- **Drawer/Modal duplicates DOM**: an open Mantine Drawer/Modal leaves the background page in the DOM. Prefix selectors with `.mantine-Drawer-body` / `.mantine-Modal-body` to target the overlay content.
- **`networkidle` timeout**: pages with open SSE streams (diagnostics, logs) may never reach `networkidle`. Use the persistent browser + `act` after the initial load, or the inline escape hatch with `waitUntil: 'domcontentloaded'` + a manual wait.

## Important notes

- Console errors and unhandled page exceptions are reported in stdout under `Errors (N):`.
- A failed action (e.g. selector not found) does NOT crash the script — it reports the error and still takes the final screenshot of the current state. Action timeout is 5 s.
- Output shows the final URL (after SPA navigation), page title, and error count.

## Escape hatch: inline Playwright

When the CLI doesn't cover a need (reading DOM values, conditional logic, custom waits), connect to the running daemon and script directly:

```bash
node --experimental-strip-types --no-warnings -e "
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const ws = readFileSync('tmp/.browse-ws', 'utf8').trim();
const browser = await chromium.connect(ws);
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('http://127.0.0.1:5173/#/instances', { waitUntil: 'networkidle' });
// --- your logic (full Playwright API) ---
const rows = await page.locator('table tbody tr').count();
console.log('instance rows:', rows);
// ---
await context.close();
await browser.close();
"
```

`browser.close()` on a connected browser only disconnects — the daemon keeps running. Prefer extending `scripts/browse.ts` with a new command over repeated inline scripts.
