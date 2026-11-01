# kvali

**One progress bar for every AI coding agent, in your terminal.** Live task progress, the current step and what the agent is doing right now, tokens and phone alerts for Claude Code, Codex, Gemini CLI, Antigravity and any agent that reads `AGENTS.md`. Grouped by project. Local and read-only.

```bash
npx @kvali/cli          # live dashboard (q to quit)
npx @kvali/cli --here   # only the project in this folder
npx @kvali/cli --json   # one snapshot as JSON, for scripts
```

Installed once with `npm install -g @kvali/cli`, the command is just `kvali`, as below.

## One-time setup

```bash
kvali setup            # alerts and automatic plans for every agent found
kvali phone            # progress and alerts on your phone (shows a QR code for the free ntfy app)
```

`kvali setup` installs Kvali's Claude Code plugin with Claude Code's own command (a live progress pane beside the chat, exact status, alerts) and asks Codex and Gemini CLI / Antigravity to keep a plan, so every task gets a real progress bar. `kvali setup off` removes all of it.

## Without a dashboard

```bash
kvali watch            # hooks and phone notifications only, e.g. in the background
```

## More

- `kvali phone test` / `kvali phone off`; options `--events needs-you,done,steps,actions,error,stuck` (what reaches the phone), `--done-after <seconds>` (the shortest task worth a notification; 0: every task), `--private` (no project or step names in notifications), `--server <url>` for your own ntfy server.
- `kvali protocol [dir]` adds the progress protocol to a repository's `AGENTS.md` for agents Kvali has no adapter for (Cursor, Copilot, …).
- `kvali --help` lists everything.

Kvali also comes as an editor extension (VS Code, Antigravity, Cursor, Windsurf): search for "Kvali" in the Extensions view. Source and docs: https://github.com/webGrandpa/kvali

Everything stays on your computer, with no telemetry; only phone notifications, when you set them up, go to the ntfy server you choose. [Privacy](https://github.com/webGrandpa/kvali/blob/main/PRIVACY.md) · [Security policy](https://github.com/webGrandpa/kvali/blob/main/SECURITY.md) · [Third-party notices](https://github.com/webGrandpa/kvali/blob/main/THIRD_PARTY_NOTICES.md)

MIT © Giorgi Khiladze

Kvali is an independent open-source project, not affiliated with or endorsed by Anthropic, OpenAI, Google, Microsoft or the makers of the other tools it works with. Claude Code, Codex, Gemini CLI, Antigravity, VS Code, Cursor, Windsurf and the other product names here are trademarks of their owners, used only to say what Kvali works with.
