# Changelog

## 0.3.0 — 2026-10-31

- **Progress inside the current step**: time on the step compared with the plan's earlier steps ("4m of ~6m"; amber when it runs long) and the number of actions taken on it. For Claude Code this also works after a long conversation is compacted, using the task files' timestamps.
- **Is it stuck?** A liveness line on every working card: active, waiting for a long command, thinking, connection/API problem with retry count, or "no output for 9m and nothing is running". The status bar shows a warning in the last two cases.
- **Latest actions**: the agent's last three tool calls with their durations (Claude Code, Codex, Antigravity).
- A `.agents/progress.md` written by Claude Code, Codex, Gemini or Antigravity now merges into that agent's card instead of showing a second card without live data; the AGENTS.md protocol tells those agents to use their built-in plan tools instead.
- **Kvali: Add Progress Protocol to AGENTS.md** updates an older Kvali section in place, and setup keeps the global plan rules current the same way.

## 0.2.0 — 2026-10-31

- **One-click setup.** A "Turn on" card (or `kvali setup`) finds Claude Code, Codex, Gemini CLI and Antigravity and enables alerts and automatic plans in one step. Kvali keeps the setup current after updates and removes all of it when the extension is uninstalled. "Kvali: Turn Off" undoes it on demand.
- **Automatic plans for Claude Code without editing CLAUDE.md**: while a session has no unfinished plan, the prompt hook returns a short planning reminder.
- Hooks bypass HTTP proxies (fixes alerts for users with `http_proxy` set).
- "Kvali: Report a Problem" opens a pre-filled GitHub issue with agent versions and parser stats, never prompts or code.
- Sessions record the agent version; cost is labeled "API value".
- Removed the manual "Ask for a plan" step.

## 0.1.0 — 2026-10-31

First release.

- Agents view: sessions from every project with plan progress, current step and activity, tokens, cost, context usage and plan limits; this workspace first.
- Adapters: Claude Code (Tasks, TodoWrite, subagent tokens), Codex (plan, tokens, 5h/weekly limits), Gemini CLI (todos, tokens, approvals), Antigravity (`task.md`, step log, permission prompts) and the AGENTS.md progress protocol (`.agents/progress.md`).
- Status bar item and notifications when an agent finishes, needs you or fails, with OS notifications while the editor is in the background.
- Claude Code hooks installer for an exact "Needs you" status.
- Sessions without a plan show steps taken this turn and an "Ask for a plan" action; "Make Agents Always Keep a Plan" adds a global planning rule for Claude Code, Codex and Gemini CLI / Antigravity.
- Cards show today's tokens next to the conversation's lifetime total.
- Built-in Anthropic prices; custom prices for any model.
- `kvali` terminal dashboard with `--json` output.
