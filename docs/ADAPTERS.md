# Writing an adapter

An adapter teaches Kvali to read one agent. It turns the agent's local files into normalized `AgentSession` objects (see `packages/core/src/model.ts`); the VS Code extension and the CLI render those without knowing which agent produced them.

## 1. Find the data

Before writing code, answer these from the agent's source or its files on disk:

| Question | Example (Codex) |
| --- | --- |
| Where are sessions stored, and how are files named? | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl` (`$CODEX_HOME` overrides) |
| Append-only JSONL, or rewritten JSON? | JSONL, one `{ timestamp, type, payload }` per line |
| Where is the project path? | `session_meta.payload.cwd` |
| Where is the plan / todo list? | `function_call` named `update_plan`, arguments `{ plan: [{ step, status }] }` |
| How do turns start and end? | `event_msg` `task_started` / `task_complete` / `turn_aborted` |
| Token usage: per request or running totals? Does input include cached tokens? | running totals in `token_count`; `input_tokens` includes `cached_input_tokens` |
| Anything about limits, approvals, errors? | `token_count.rate_limits.primary/secondary` |

Prefer reading the agent's open source code over guessing from one file. Note the version you checked in the adapter's header comment.

## 2. Implement

Most agents write one JSONL file per session. Extend `JsonlSessionAdapter` and implement four methods; the base class handles discovery throttling, the active-time window, incremental tailing and file truncation:

```ts
import { JsonlSessionAdapter, type AdapterContext, type Candidate } from '../adapter.ts';

interface MyState { file: string; startedAt?: number; updatedAt: number; /* … */ }

export class MyAgentAdapter extends JsonlSessionAdapter<MyState> {
  readonly id = 'my-agent';
  readonly label = 'My Agent';

  protected async discover(ctx: AdapterContext): Promise<Candidate[]> {
    // list session files with their mtime; keep it cheap (runs every 5 s)
  }
  protected createState(file: string): MyState {
    return { file, updatedAt: 0 };
  }
  protected onRecord(state: MyState, record: unknown, ctx: AdapterContext): void {
    // fold ONE parsed line into state; never throw on unexpected shapes
  }
  protected toSession(state: MyState, ctx: AdapterContext) {
    // build the AgentSession, or return undefined to hide it
  }
}
```

Agents with other layouts (whole-file JSON, one directory per conversation) implement the `Adapter` interface directly; see `gemini-cli.ts` and `antigravity.ts`.

Then add it to `createDefaultAdapters()` in `engine.ts` and to the `kvali.agents.disabled` enum in `packages/vscode/package.json`.

## 3. Rules of thumb

- **Read-only, local, cheap.** Never write to the agent's files. Never make network calls. `poll()` runs every 1.5 s, so read only appended bytes (`JsonlTail`) and re-read side files only when their mtime changes.
- **Be liberal in what you accept.** Agent formats change. Check types (`typeof x === 'string'`) instead of trusting shapes, and skip what you do not understand.
- **Do not double count tokens.** Find out whether usage is per request (sum it, de-duplicated by request or message id) or a running total (take the latest).
- **Status from facts, time as a fallback.** Prefer explicit turn events. When the format has none, use `staleness()` and clear, conservative timeouts.
- **Never store prompts or code.** The session model carries titles, plan items, activity labels and numbers only.
- **Hide subagents** as separate sessions; count their tokens toward the parent when the format allows.

## 4. Test

Add `packages/core/test/<agent>.test.ts`. Build fixtures in code with the helpers in `test/helpers.ts` (`tmpHome`, `writeJsonl`, `appendJsonl`, `Clock`), so the test documents the format. Cover at least: a working session with a plan and activity, the transition to idle/done after appending lines, token math, and one malformed or unexpected line.

```bash
pnpm test
```

Attach a sanitized snippet of real files to your pull request (remove prompts, code and paths you do not want to share).
