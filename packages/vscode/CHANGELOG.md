# Changelog

## 0.1.0 — 2026-10-31

First release.

- Agents view: sessions from every project with plan progress, current step and activity, tokens, cost, context usage and plan limits; this workspace first.
- Adapters: Claude Code (Tasks, TodoWrite, subagent tokens), Codex (plan, tokens, 5h/weekly limits), Gemini CLI (todos, tokens, approvals), Antigravity (`task.md`, step log, permission prompts) and the AGENTS.md progress protocol (`.agents/progress.md`).
- Status bar item and notifications when an agent finishes, needs you or fails, with OS notifications while the editor is in the background.
- Claude Code hooks installer for an exact "Needs you" status.
- Built-in Anthropic prices; custom prices for any model.
- `kvali` terminal dashboard with `--json` output.
