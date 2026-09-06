# Codex instructions

Read and follow [CLAUDE.md](CLAUDE.md) before working in this repository. It is the shared source
of project rules for Claude Code and Codex.

Before changing a file, read every applicable nested `CLAUDE.md` along its path, from the repository
root to the file's directory. The zone table in the root `CLAUDE.md` lists the current zones;
deeper instructions refine the parent rules. Do this even when starting Codex at the repository root.

Keep shared rules in `CLAUDE.md`; keep `AGENTS.md` files as thin entrypoints. When adding a new
zone's `CLAUDE.md`, add a sibling `AGENTS.md` that directs Codex to read it.

Repository skills live in `.codex/skills/`. For visual UI checks, read
[browse](.codex/skills/browse/SKILL.md) if it is not in the session's available skills.
