# Privacy

Kvali runs on your computer. It has no account, no telemetry and no analytics, and it reports to no server of its author. This page covers the VS Code extension (also in Antigravity, Cursor and Windsurf), the `kvali` command (`@kvali/cli`) and Kvali's Claude Code plugin.

## What Kvali reads

- The files AI coding agents keep on your computer: Claude Code (`~/.claude`), Codex (`~/.codex`), Gemini CLI and Antigravity (`~/.gemini`), and `.agents/progress.md` in your projects. Kvali reads them to show plans, the current step, tokens and API value, and never changes them.
- Events that agent hooks and Kvali's Claude Code plugin hand over on this computer (`127.0.0.1`).

## What Kvali writes

- `~/.kvali/`: its settings (`config.json`, readable only by your user account), the latest event of each session (`live/`, cleared after three days), the open editor windows, and a copy of its Claude Code plugin.
- Only when you choose **Turn on** (or run `kvali setup`): Kvali's Claude Code plugin, added with Claude Code's own `claude plugin` command (or Kvali's hooks in `~/.claude/settings.json` for a Claude Code without plugins), and a short, marked planning rule in `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`. **Kvali: Turn Off**, `kvali setup off` and uninstalling the extension remove all of it.
- Only when you run them: **Kvali: Add Progress Protocol to AGENTS.md** (or `kvali protocol`) adds a marked section to the project's `AGENTS.md`; `kvali plan-rule` adds the planning rule to the agents' global instruction files, `~/.claude/CLAUDE.md` included.

## What leaves your computer

Nothing, unless you set up **phone notifications**. Then:

- Notifications go over HTTPS to the ntfy server you chose, by default the public [ntfy.sh](https://ntfy.sh), and from there to the ntfy app on your phone.
- A notification names the agent and the event (needs you, finished, error, gone quiet) with progress and timing. Unless you turn details off (`kvali phone --private`), it also names the project folder, the title the agent gave its work, the plan's step names and the agent's short status line, such as "Needs approval: Bash" or its error message; with **every action** chosen, also the short label of the action running (for example "Run the tests"). It never contains your code, file contents, prompts or command lines. When an agent gave a session no title of its own, its title would be your first message, so it is left out.
- Kvali also asks the server how many notifications are left for the day (`GET /v1/account`), to save the rest for alerts.
- ntfy.sh is a separate service with its own [privacy policy](https://docs.ntfy.sh/privacy/) and [terms](https://docs.ntfy.sh/terms/). It keeps messages for a while (12 hours by default) so your phone can fetch them, and the App Store and Google Play apps receive them through Apple's and Google's push services. Anyone who knows a topic's name can read that topic, so Kvali makes an unguessable one (80 random bits): keep it to yourself. For full control, run your own ntfy server: `kvali phone --server https://ntfy.example.com --token tk_…`.
- **Kvali: Stop Phone Notifications** or `kvali phone off` stops them and removes the setup.

## Reporting a problem

**Kvali: Report a Problem** opens a pre-filled GitHub issue in your browser and copies the same text to the clipboard: Kvali's version, the editor and operating system, which agents were found with their versions, how many sessions are in each state, and error messages with file paths removed. It holds no prompts, titles, paths or code. Nothing is sent until you submit the issue yourself, and GitHub issues are public.

## Changes

Changes to what Kvali reads, writes or sends are listed in the [changelog](CHANGELOG.md). Questions: [open an issue](https://github.com/webGrandpa/kvali/issues). Security problems: see [SECURITY.md](SECURITY.md).
