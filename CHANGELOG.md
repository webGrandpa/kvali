# Changelog

## 0.6.1 — 2026-10-31

- The extension's listing has a plainer name and keywords: "Kvali — AI Agent Progress".
- The release and CI workflows use the current GitHub Actions (Node 24).
- The Claude Code plugin's version follows Kvali's, so a plugin installed from GitHub (`/plugin install kvali --marketplace webGrandpa/kvali`) gets each release with `claude plugin update`.

## 0.6.0 — 2026-10-31

- **Turn on installs Kvali's Claude Code plugin** with Claude Code's own `claude plugin` command (found inside the Claude Code editor extension when there is no `claude` on PATH). No terminal step, and Kvali keeps the plugin updated: Claude Code reads it in place from `~/.kvali/claude-plugin`.
- **One connection per agent**: with the plugin on, Kvali removes its Claude Code hooks; they remain only as the fallback for a Claude Code that cannot load plugins. Existing setups move over by themselves.
- Automatic planning lives in the plugin (it follows `kvali.autoPlan`). Turn Off and uninstalling remove the plugin too.
- The CLI ships the plugin as well: `kvali setup` installs it.
- Release automation: one version tag publishes to the VS Code Marketplace, Open VSX, npm (`npx @kvali/cli`) and a GitHub release (see RELEASING.md).
- **Progress on your phone**, on by default: one silent notification per task with a progress bar and the current (or next) step, updated as steps finish, at most once a minute; when the task ends the same notification turns into "finished" or "stopped at 5/7" (ntfy updates it in place on Android; the iPhone app lists each update). The **Progress** switch in the phone card or `kvali phone --no-steps` turns it off. Setups saved by 0.5 get it too.
- **A question reaches the phone only after a minute without an answer**, and so does a stop in the middle of a plan: answered at the computer, it sends nothing. Before, every permission prompt was a high-priority push.
- **Fixed: only the test notification reached the phone.** "Finished", "went quiet" and "API trouble" are about time passing, but the editor and `kvali watch` looked for them only when an agent's data changed, which after a finished task it no longer does. They now look every few seconds as well (and never act on an older snapshot after a newer one).

## 0.5.1 — 2026-10-31

- Phone notifications are found at the top of the Agents view: "Get alerts on your phone" until they are set up, then "Phone alerts on · Show QR code". The card scrolls into view when it opens.

## 0.5.0 — 2026-10-31

- **Phone notifications** through the free ntfy app (iPhone and Android): "needs you", a long task finished or stopped mid-plan, an error, API trouble, a quiet or vanished agent, and optionally each finished step, for every agent. One command sets it up with a QR code (**Kvali: Send Notifications to My Phone** or `kvali phone`); one window per machine sends, so each event arrives once.
- `kvali watch`: hooks and phone notifications without the dashboard, for terminal-only setups.
- The Claude Code plugin (0.2.0) sends its own session's notifications with exact timing, and tells the extension so nothing arrives twice.

## 0.4.0 — 2026-10-31

- **Kvali for Claude Code**, a plugin (`packages/claude-plugin`): a pane beside the chat with the plan's progress bar, the current step and its time, what Claude is doing right now and the session's tokens, in the terminal, the desktop app and the VS Code extension. It reads Claude Code's own events (the model's stream, tool calls, permission prompts, compaction), so "thinking for 6 minutes" and "no data from the API for 1m 30s" are facts, not guesses.
- The extension reads the plugin's heartbeat: exact liveness in the sidebar for Claude Code sessions, "Needs you" without hooks, and a warning within 30 seconds when a working Claude Code was closed or froze.

## 0.3.0 — 2026-10-31

- **Progress inside the current step**: time on the step compared with the plan's earlier steps ("4m of ~6m"; amber when it runs long) and the number of actions taken on it. For Claude Code this also works after a long conversation is compacted, using the task files' timestamps.
- **Is it stuck?** A liveness line on every working card: active, waiting for a long command, thinking, connection/API problem with retry count, or "no output for 9m and nothing is running". The status bar shows a warning in the last two cases.
- **Latest actions**: the agent's last three tool calls with their durations (Claude Code, Codex, Antigravity).
- A `.agents/progress.md` written by Claude Code, Codex, Gemini or Antigravity now merges into that agent's card instead of showing a second card without live data; the AGENTS.md protocol tells those agents to use their built-in plan tools instead.
- The context meter reads "context 43%" instead of "ctx", and its tooltip explains what the context window is and what happens near 100%.
- README screenshots show the current panel.
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
