---
name: browse
description: Navigate and visually inspect the running arriero web UI with Playwright via pnpm browse. Use for page checks, screenshots, hash-route navigation, and UI interactions.
---

# Browse

Read [the shared browse procedure](../../../.claude/skills/browse/SKILL.md) before using the browser.
It owns the commands, selectors, daemon lifecycle, and troubleshooting guidance.

Apply these Codex tool adaptations:

- Run commands from the repository root through the shell tool. The shared procedure's `Bash`,
  `Read`, and `allowed-tools` names belong to Claude Code.
- View `tmp/screenshots/browse.png` and intermediate screenshots with the image-viewing tool
  (`view_image`), rather than reading them as text.
- The `! pnpm dev` notation is Claude Code-specific. If the UI is unavailable and starting local
  development is within the user's task, run `pnpm dev` in a persistent shell session and wait for
  readiness before browsing.
