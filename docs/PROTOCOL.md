# Progress protocol v1

A tiny, agent-agnostic way for **any** coding agent to report progress: a markdown checklist in a known place. If an agent can edit files, it can speak this protocol. No SDK, no network, no tokens spent on tool calls.

Kvali reads it natively for agents it has no adapter for (Cursor, GitHub Copilot, Windsurf, Cline, Aider, …). Agents that already have a built-in plan tool (Claude Code Tasks, Codex `update_plan`, Gemini CLI `write_todos`, Antigravity `task.md`) should keep using it; Kvali reads those directly.

## File location

```
<workspace>/.agents/progress.md              one agent
<workspace>/.agents/progress/<name>.md       several agents at once, one file each
```

These files are ephemeral. Add `.agents/progress*` to `.gitignore`.

## Format

```md
---
agent: Cursor          # who is working (shown as the agent name)
status: working        # working | waiting | done | error (optional)
note: Which palette?   # optional, shown when status is waiting
model: gpt-5.5         # optional
---
# Dark mode for the dashboard

## Design tokens
- [x] Define color tokens
- [x] Map tokens to CSS variables

## Components
- [/] Update the sidebar
- [ ] Update charts
- [-] Restyle legacy table (dropped)
- [!] Update the PDF export (blocked: needs a font license)
```

| Marker | Meaning |
| --- | --- |
| `[ ]` | pending |
| `[/]` | in progress (keep exactly one) |
| `[x]` | done |
| `[-]` | cancelled, not counted in progress |
| `[!]` | blocked |

- The first `#` heading is the task title. `##` headings group steps.
- Items may be nested with indentation and may use `1.` instead of `-`.
- Front matter is optional. Without `status`, Kvali derives it: any `[/]` → working, everything `[x]` → done, otherwise idle. A working file that stays unchanged for 30 minutes is shown as stale.

## Telling agents to use it

Run **Kvali: Add Progress Protocol to AGENTS.md** (or `kvali protocol` in a terminal). It appends this section to `AGENTS.md`, which most agents read automatically:

```md
## Progress reporting

For any task that takes more than two steps, keep your plan visible so the user can follow progress without asking:

- If you have a built-in plan or todo tool (Claude Code Tasks/TodoWrite, Codex `update_plan`, Gemini CLI `write_todos`, Antigravity `task.md`), create the plan before you start and update it as you go.
- Otherwise, maintain `.agents/progress.md` in this format: …
- Keep exactly one step marked `[/]`. Update the file right after each step, set `status: waiting` when you need input from the user, and `status: done` when everything is finished.
```

## Versioning

The protocol is versioned by the marker comment `<!-- kvali:progress-protocol v1 -->` in AGENTS.md. Future versions will stay backwards compatible with v1 files.
