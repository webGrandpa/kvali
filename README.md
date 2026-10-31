# Kvali

**One progress bar for every AI coding agent.**
Live task progress, the current step, tokens, cost and plan limits for Claude Code, Codex, Gemini CLI, Antigravity — and any other agent that reads `AGENTS.md`. Grouped by project, right inside VS Code, Antigravity, Cursor or Windsurf, or in your terminal.

<p align="center">
  <img src="docs/images/agents-dark.png" width="340" alt="Kvali's Agents view: sessions grouped by project with progress bars, current step, tokens and cost" />
  &nbsp;&nbsp;
  <img src="docs/images/agents-light.png" width="340" alt="The same view in a light theme" />
</p>

> *Kvali* (კვალი) is Georgian for "trace": every agent leaves one on disk. Kvali reads it so you never have to type "what's the progress?" again.

## Why

Long agent runs are a black box. You either babysit the chat or keep asking for a status update, which costs tokens and breaks the agent's flow. Meanwhile, every agent already writes everything Kvali needs to your disk: its plan, the tool it is running, and the tokens it spent. Kvali turns that into:

- **Progress to 100%**: the agent's own plan (Claude Code Tasks, Codex `update_plan`, Gemini `write_todos`, Antigravity `task.md`) as a progress bar with the step it is on.
- **What it is doing right now**: "Running `pnpm test` · 41s", "Editing `src/app.tsx`".
- **Needs you**: permission prompts and questions surface in the status bar and as notifications, including OS notifications when the editor is in the background.
- **Tokens and cost**: per session, per project and per day, with input, output, cache and context usage. Cost is estimated at API list prices (built in for Anthropic models, configurable for others).
- **Plan limits**: 5-hour and weekly usage for Codex subscriptions, straight from Codex's own logs.
- **Every project at once**: sessions are grouped by project; the current workspace comes first.

Everything is local and read-only. Kvali never sends your data anywhere.

## Supported agents

| Agent | Progress from | Current step | Tokens | Cost | Plan limits | "Needs you" |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** (CLI, VS Code, Desktop) | Tasks / TodoWrite | ✓ | ✓ incl. subagents | ✓ built in | — | ✓ with hooks¹ |
| **Codex** (CLI, IDE) | `update_plan` | ✓ | ✓ | via `kvali.pricing` | ✓ 5h + weekly | — |
| **Gemini CLI** | `write_todos` | ✓ | ✓ | via `kvali.pricing` | — | ✓ |
| **Antigravity** agent | `task.md` | ✓ | not stored locally | — | — | ✓ |
| **Anything that reads AGENTS.md** — Cursor, Copilot, Windsurf, Cline, Aider, … | [`.agents/progress.md`](docs/PROTOCOL.md) | ✓ | — | — | — | ✓ |

¹ Claude Code's transcript does not record permission prompts. One click installs four tiny async hooks that report them (see [Claude Code hooks](#claude-code-hooks)). Without hooks, everything else still works.

Want another agent? Adapters are small; see [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Install

**Editor extension** (VS Code ≥ 1.90, Antigravity, Cursor, Windsurf, VSCodium):

- From a release: download `kvali-x.y.z.vsix`, then run **Extensions: Install from VSIX…** from the Command Palette (or `code --install-extension kvali-x.y.z.vsix`).
- From source: `pnpm install && pnpm package`, which writes `packages/vscode/kvali-0.1.0.vsix`.

Open the **Kvali** icon in the activity bar. Sessions from the last 24 hours appear automatically.

**Terminal** (any editor, including JetBrains):

```bash
pnpm install && pnpm build
node packages/cli/dist/kvali.mjs          # live dashboard, q to quit
node packages/cli/dist/kvali.mjs --here   # only this project
node packages/cli/dist/kvali.mjs --json   # one snapshot as JSON, for scripts
```

## Get the most out of it

1. **Let agents keep a plan.** Progress is only as good as the agent's plan. Run **Kvali: Add Progress Protocol to AGENTS.md** once per repository. Agents with a built-in plan tool are told to use it for every multi-step task; all other agents are told to keep `.agents/progress.md` up to date ([format](docs/PROTOCOL.md)).
2. **Claude Code users: install the hooks** for an exact "Needs you" status (button in the view, or **Kvali: Install Claude Code Hooks**).
3. **Codex / Gemini on API keys: add prices** in `kvali.pricing` to see cost (tokens are always shown).

## Claude Code hooks

**Kvali: Install Claude Code Hooks** adds four `async` command hooks to `~/.claude/settings.json` for `UserPromptSubmit`, `Notification`, `Stop` and `SessionEnd`:

```bash
curl -s -m 2 -o /dev/null -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47821/v1/events/claude-code || true
```

- They run in the background and always exit 0, so they never slow down or block Claude Code, even when no editor is open.
- Claude Code reports when a permission prompt appears, but not the moment you approve it. Kvali clears "Needs you" as soon as the transcript moves on, so a long command you approved may show "Needs you" until it finishes.
- The editor window that owns port 47821 (any Kvali window, or the `kvali` CLI) stores only the event name, session id, notification type and message in `~/.kvali/live/`. Prompts, tool inputs and code are never stored.
- Your existing settings and hooks are kept, and the previous file is saved as `settings.json.kvali-backup`. **Kvali: Remove Claude Code Hooks** (or `kvali hooks uninstall`) takes them out again.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `kvali.scope` | `all` | `all` projects (this workspace first) or only `workspace` |
| `kvali.activeWindowHours` | `24` | How far back sessions are shown |
| `kvali.staleAfterMinutes` | `30` | A working session that goes quiet this long is marked stale |
| `kvali.notifications.onFinish` | `true` | Notify when an agent finishes |
| `kvali.notifications.onNeedsInput` | `true` | Notify when an agent needs you |
| `kvali.notifications.system` | `true` | Also use macOS / Linux notifications when the editor is in the background |
| `kvali.statusBar.enabled` | `true` | Status bar item for this workspace |
| `kvali.cost.show` | `true` | Show estimated cost |
| `kvali.pricing` | `{}` | Prices in USD per million tokens, e.g. `{ "gpt-5.5*": { "input": 1.25, "output": 10, "cacheRead": 0.125 } }` |
| `kvali.agents.disabled` | `[]` | Agents Kvali should not read |
| `kvali.antigravity.brainDirs` | `[]` | Extra Antigravity data folders |
| `kvali.hooks.port` | `47821` | Local port for agent hooks |

## How it works

```
 Claude Code ─┐ ~/.claude/projects/*.jsonl, ~/.claude/tasks/
 Codex ───────┤ ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 Gemini CLI ──┤ ~/.gemini/tmp/*/chats/session-*.jsonl          ┌──────────────┐    ┌───────────────────┐
 Antigravity ─┤ ~/.gemini/antigravity-ide/brain/*/  ──▶ adapters ─▶│ @kvali/core  │──▶ │ VS Code extension │
 AGENTS.md ───┘ <repo>/.agents/progress.md                      │ engine       │    │ CLI dashboard     │
 agent hooks ──▶ 127.0.0.1:47821 ──▶ ~/.kvali/live/ ──────────────▶│ (normalizes) │    └───────────────────┘
                                                                └──────────────┘
```

- `packages/core` is editor-agnostic. Each adapter tails its agent's files incrementally (only appended bytes are read) and produces one normalized `AgentSession` model: status, plan, current activity, tokens, cost, context and limits.
- `packages/vscode` renders the model as a sidebar view, a status bar item and notifications.
- `packages/cli` renders the same model in a terminal.

## Development

```bash
pnpm install
pnpm test        # adapter and engine tests (node:test, no extra deps)
pnpm typecheck
pnpm build
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- Claude Code plan limits (5h / weekly) through a status line bridge
- Adapters: Cursor, GitHub Copilot CLI, Cline / Roo Code / Kilo Code, OpenCode, Qwen Code, Aider
- Codex and Gemini CLI hooks for exact "needs approval" status
- Per-project token budgets with alerts
- A Claude Code mod that draws progress inside Claude Code's own panel

## License

[MIT](LICENSE) © 2026 Giorgi Khiladze
