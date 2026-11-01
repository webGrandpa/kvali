# Kvali for Claude Code

Live progress for long Claude Code tasks, in a pane beside the chat:

- **The plan** as a progress bar (Claude Code's Tasks or TodoWrite), with the step in progress.
- **The current step on a clock**: "4m 12s on this step · usually ~6m", from how long this plan's earlier steps took.
- **What Claude is doing right now**, straight from Claude Code's own events, so nothing is guessed: thinking, writing the answer, preparing a tool call, running “pnpm test” for 41s, waiting for your answer, or "no data from the API for 1m 30s" when the connection stalls.
- **The latest actions** with their durations, and the **tokens** the session spent with how full the context window is.

The status line shows the short version (`Kvali · 3/7 · 43% · Writing tests · thinking`), and a long turn ends with a notification.

It works wherever Claude Code runs: the terminal, the desktop app, the VS Code extension. The pane opens by itself where it docks beside the chat (desktop app, VS Code); type `/kvali` to open it anywhere else.

## On your phone

With phone notifications set up (`kvali phone` or **Kvali: Send Notifications to My Phone** in the editor), the plugin sends this session's pushes through ntfy by itself, no editor needed: the turn's progress through its plan as one silent notification that each finished step updates (at most once a minute) and the turn's end replaces, and alerts when a question has waited a minute for your answer (one answered at the computer sends nothing), a turn of two minutes or more (or one whose progress you followed) finished, or stopped mid-plan and waited a minute, an error, or no data from the API. It follows the choices made in Kvali's phone card or with `kvali phone --events` (each finished step, every action live, every task or only longer ones) and reads the shared setup in `~/.kvali/config.json` once a minute.

## With the Kvali editor extension

The plugin also writes a small heartbeat file per session to `~/.kvali/live/claude-code/<session>.mod.json`. The [Kvali extension](../../README.md) reads it, so its sidebar shows the same exact state for every Claude Code session on your machine, and it can tell "thinking for 6 minutes" from "Claude Code was closed or froze". The heartbeat never leaves your computer.

## Install

- **With Kvali's editor extension** (VS Code, Antigravity, Cursor, Windsurf): click **Turn on** in the Kvali view. Kvali installs this plugin with Claude Code's own command and keeps it updated.
- **With Kvali's CLI**: `npx @kvali/cli setup`.
- **On its own**, at the prompt of a terminal Claude Code session: `/plugin install kvali --marketplace webGrandpa/kvali` (from a shell: `claude plugin install kvali --marketplace webGrandpa/kvali`). In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `webGrandpa/kvali`, then Add plugin.

Then start a new Claude Code session (or run `/reload-plugins`).

## Development

```bash
claude plugin validate packages/claude-plugin
claude plugin test packages/claude-plugin
```

`hooks/model.ts` holds the logic (plan, step timing, the "is it working?" line), `hooks/register.tsx` connects it to Claude Code's events and draws the pane, `types/index.d.ts` declares the state it keeps.

## Privacy

The plugin keeps its state on your computer and has no telemetry. It sends something only when you set up phone notifications: short status lines to the ntfy server you chose, never code or prompts. [Privacy](https://github.com/webGrandpa/kvali/blob/main/PRIVACY.md) · [Security policy](https://github.com/webGrandpa/kvali/blob/main/SECURITY.md) · MIT License

Kvali is an independent open-source project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, used only to say what this plugin works with.
