# Changelog

## 0.7.5 — 2026-11-11

- **An API error Claude Code retries is no longer shown as the session's error.** When a request failed and Claude Code was about to try it again (an overloaded API, a dropped connection), the card said "Error" with "[object Object]" while Claude worked on. Now it stays "Working" and says what happened, such as "Overloaded (529)", with the attempt; only an error that ends the turn shows as an error, and once Claude works again the card follows. Error messages from Claude Code, Antigravity and Cline read as words, never "[object Object]".

## 0.7.4 — 2026-11-11

- **A Claude Code turn that ends without last words ends on the card too.** When Claude finished a turn right after a tool, with nothing more to say, Claude Code wrote no last message, and Kvali kept the session "Working", then warned "No output for 22m… it may be stuck" while Claude was waiting for you. Kvali now ends the turn on Claude Code's own record of it, and where Kvali's Claude Code plugin runs, on the plugin's word that the turn ended.
- A background command's result that arrives after a turn has ended, and that Claude does not answer, no longer keeps the session "Working": after two minutes with no answer it is idle again.

## 0.7.3 — 2026-11-10

- **Time left no longer guesses for a step that runs long.** A step that had run for 30 minutes, in a plan whose earlier steps took a minute and a half, showed "~1m left": Kvali counted it as nearly done. Now a step past twice its usual time shows no estimate (the card still says it is slower than the earlier steps), and one just past its usual time still counts a quarter of a step. On the cards, in the status bar, `kvali`, the Claude Code pane and the phone.
- **A subagent's plan no longer takes over the session's.** When a subagent Claude started kept a to-do list of its own, Kvali's Claude Code plugin showed that list as the session's plan ("6/6 · 100%" while the session was at 3 of 5), in its status line, its pane and the phone's progress notification. The plugin and the editor now follow the session's own plan, and leave out tasks a subagent adds to the session's task list. An agent team's shared list still counts.

## 0.7.2 — 2026-11-09

A security release: an independent review of Kvali found ways a project's files, a web page or another program could misuse it. Each is fixed below, and kept fixed by tests.

- **Phone notifications never carry command lines.** An approval now says only what kind it is ("Needs approval: run a command"), and "going in circles" names the action, not its command. A project's `.agents/progress.md` no longer words a notification: its note for "waiting" stays on your computer, and an agent name in it that is more than a short name is sent as "An agent".
- **Turning Kvali off never removes your text.** Kvali's start and end markers count only on lines of their own, outside code blocks, and a section whose end marker is gone is left as it is; before, Turn Off removed everything after the start marker. Files Kvali changes (`~/.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, its own settings) are written beside them and renamed into place, so they are never left half-written, and keep their permissions and their links when they were links; instruction files keep their Windows line endings. `~/.kvali`, Kvali's settings and its backups are readable only by your user account.
- **Text from files is only text.** Titles, steps, actions and messages have terminal escape sequences, control characters and invisible or direction-changing characters removed before Kvali shows or sends them, so a file cannot clear or recolor your terminal, write your clipboard, or make a name read differently from what it is. The week card's SVG escapes every name.
- **Files cannot slow Kvali down or hide an agent.** Every pattern Kvali matches in agents' and projects' files runs in linear time. A transcript line over 8 MB is skipped, a progress file is read up to 2,000 characters a line and 500 steps, and plan-limit readings from the future are dropped. An unexpected error in one refresh no longer stops the ones after it. One record Kvali cannot read leaves out that record, where before it could hide all of the agent's sessions. A project's progress files are read only from inside the project (never through a link out of it), the 20 most recent at most, and one joins an agent's card only when it names that agent ("Claude Code" or "Claude"), not when its name merely appears in the agent's.
- **The hook endpoint takes requests from hooks only.** It refuses requests a browser marks as sent by a web page and any type but `application/json`, so a page can no longer post an event to it as "text/plain", and it drops slow or idle connections. Its files are readable only by you.
- **Settings a project cannot change.** The hook port, the folders Kvali reads Antigravity's plans from, automatic plans, prices, the agents turned off and the polling interval are user settings only: a repository's `.vscode/settings.json` no longer sets them. Numbers are kept within their ranges, and a price with a typo is ignored instead of turning costs into NaN.
- **Go to agent and Resume** open folders and start terminals only in local folders that exist, never on a network share, hand another extension only a plain session id, and check what other Kvali windows report. The Kvali view can run only its own commands.
- **Telegram pairs with a code.** Kvali shows a one-time code (pressing Start in the link it opens sends it) and pairs with the chat that sends it, after you confirm the chat's name; before, the first message anyone sent the bot would do.
- **Kvali: Report a Problem** lists agent versions only when they are version numbers, and removes your home folder from error messages whole, a user name with a space in it included.
- `kvali`: `--window` and `--port` must be numbers in range, and `kvali week --svg` does not write through a link.
- Releases: every GitHub Action is pinned to a commit, checkouts keep no credentials, CI runs with read-only permissions, and Dependabot keeps the pins current.
- The README said the plan request costs ~60 tokens; it is about 100.

## 0.7.1 — 2026-11-09

- **Claude Code's progress bar fills again with current Claude models.** Recent Claude Code gives its task-list tools (TaskCreate, TaskUpdate) only to models up to Opus 4.7 and Sonnet 4.6, unless `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set. With a newer model Claude could not keep a plan: it searched for the tools, found none, and the card showed only the moving bar. With automatic plans on, Kvali now sets that variable in `~/.claude/settings.json`, for Claude Code sessions started from then on. A value you set yourself is left as it is; Turn Off, or automatic plans off (`kvali.autoPlan`), removes Kvali's. When the tools are not there, the plan request now stops after one search.
- With Kvali in two editors, the one not updated yet no longer puts its older Claude Code plugin back each time it starts.

## 0.7.0 — 2026-11-08

- **Five more agents, with no setup**: GitHub Copilot (the Copilot CLI, and VS Code's Copilot chats that run on the same agent runtime), Cline, Roo Code, Kilo Code and OpenCode. Their plans become progress bars (Copilot's `update_todo` and todo table, Cline's focus chain, Roo Code's todo list, OpenCode's and Kilo Code's `todowrite`), with the step they are on, tokens and API value as each agent priced them, and "needs you" for approvals and questions: exact for Copilot and OpenCode, after three seconds for Cline and Roo Code (a step they approve by themselves passes at once). Cline and Roo Code are found in every editor built on VS Code (VS Code, Cursor, Windsurf, Antigravity, VSCodium, …), editor profiles and remote servers included. OpenCode and Kilo Code keep their sessions in SQLite, which Kvali reads with the editor's built-in SQLite (current VS Code, Cursor and Windsurf; Node 22.13 or later for `kvali`).
- **Time left**: a working agent with a plan shows how long the rest should take, "~20m left", from how long its earlier steps took: on the card, in the status bar, the Claude Code plugin's pane, `kvali` and the phone's progress notification.
- **Plan limits with a forecast**: Claude Code's 5-hour and weekly limits (through Kvali's Claude Code plugin) and Codex's, with when each runs out at the pace of the last hour, if that comes before it resets: "5h 72% · runs out in ~40m". At the top of the view, in the status bar and in `kvali`, and a phone notification when one is about to run out (the new **limits** choice).
- **Going in circles**: when an agent's same action fails again and again with the same error (four times in a row, or eight failures of any kind), its card says so with the tokens it cost, and an editor notification (and the phone's **stuck** choice) suggests giving it a hint. For Claude Code, Codex, Copilot, Cline, Roo Code, Kilo Code and OpenCode.
- **Go to agent**: one click on a card, or **Go to agent** on a notification, takes you to the terminal that runs the agent (Kvali finds its process), the window that has its project open, or the agent's own panel: the session's own chat in the Claude Code extension, opened again if you closed its tab, Cline, Roo Code, Kilo Code, Copilot Chat, and the views of the Codex extension. **Kvali: Go to Agent…** lists every session, those that need you first. The card's "Open" link is now "Transcript".
- **Plans in current Claude Code**: Claude Code keeps its task tools (TaskCreate, TaskUpdate) behind ToolSearch, where a model asked for a plan often does not find them, so the card's bar only moved back and forth ("% appears as soon as the agent writes its plan"). With automatic plans on, Kvali's plugin keeps them in Claude's tool list from a session's start, the plan request (hooks too) says how to load them otherwise, and a turn that began without a plan (a resumed session, a prompt the model planned nothing for) is asked for one once, after six tool calls, beside a tool's result. Kvali's hooks also stay beside its plugin now, so a Claude Code that cannot load the plugin (an older one in another editor, such as Antigravity's) still gets the plan request, and Kvali writes Claude Code's settings only when its hooks there need to change.
- **Telegram and Discord**: the same notifications through a Telegram bot of your own or a Discord channel's webhook, besides ntfy or instead of it, with the progress message edited in place. Set them up from the phone card, or with `kvali phone telegram` and `kvali phone discord`.
- **Share my week**: **Kvali: Share My Week** draws your agents' last seven days as an image: hours of agent work, tasks done, tokens, sessions, the agents you used and a bar per day, wide for X and link previews or tall for LinkedIn and Instagram. Save or copy it with a ready post, or open X or LinkedIn with the text filled in. Counts only: no project names, titles or prompts. In a terminal: `kvali week` (`--svg` writes the card).
- Model ids written with a dot (`claude-sonnet-4.5`) get Anthropic prices.

## 0.6.8 — 2026-11-06

- **Agents in the background count as work.** When Claude ended its answer while agents it had started in the background worked on, Kvali showed the session as Idle and sent "finished". Now the session stays "working" ("Waiting for 2 background agents") until each one reports back, and the "finished" notification, on the phone too, comes once at the real end, timed from the start. A workflow run in the background counts the same way, and its agents' tokens are added to the session.
- The subagent count on a card no longer lights up for old subagents right after Kvali starts.

## 0.6.7 — 2026-11-02

- **A turn's clock starts with each run.** When something other than your prompt set Claude Code going (a scheduled wake-up, a PR or task notification, a slash command), Kvali counted the time and steps from your last prompt, so a session woken after two days showed "9 steps · 2d 8h". A turn now starts whenever the agent sets off again after its last turn ended.

## 0.6.6 — 2026-11-01

- **No false "Needs you" in auto mode.** In Claude Code's auto mode a classifier approves or blocks most actions by itself, and Kvali's plugin took each of those checks for a question to you. Now a call shows "Needs you" only when Claude Code puts it to you: an ask rule or a hook's ask, and the prompts auto mode falls back to (after its classifier blocks three in a row, say).
- **Calmer editor notifications**: a "needs you" notification waits 5 seconds, so a question answered or settled in that time sends nothing, and comes at most once a minute per session. The status bar shows every question as before.

## 0.6.5 — 2026-11-01

- The extension is listed as "Kvali — AI Agent Progress Tracker", so a search for a progress tracker finds it.

## 0.6.4 — 2026-11-01

- **`kvali setup` from npm installs the Claude Code plugin again.** Since 0.6.0 the npm package was missing the plugin's manifest (`.claude-plugin/`), so a setup from the terminal fell back to hooks. The release workflow now keeps that folder, and it stops before publishing an npm package without it.
- The Marketplace and Open VSX pages open with a short demo of Kvali at work.

## 0.6.3 — 2026-11-01

- **Your prompts stay on your computer.** When an agent gives a session no title of its own, Kvali titles it with your first message; phone notifications now leave such a title out.
- **Licenses and policies**: the extension and the npm package include `THIRD_PARTY_NOTICES.md`, the licenses of the two libraries they bundle (Preact and qrcode-generator), and the release build stops when a bundled library is missing from it. New `PRIVACY.md` (what Kvali reads, writes and sends) and `SECURITY.md` (how to report a vulnerability privately). The Claude Code plugin ships its MIT license.
- **Kvali: Report a Problem** removes file paths from the error messages it quotes.
- The hook endpoint on 127.0.0.1 refuses requests addressed to any other host name, so a web page cannot reach it through DNS rebinding.

## 0.6.2 — 2026-11-01

- **Choose what reaches your phone.** The phone card has a checkbox for each kind of notification: a question that waited a minute, a task done, each finished step, every action, an error, an agent gone silent, and how long a task must be to be worth one (any length, 30 s, 2 min or 5 min). In a terminal: `kvali phone --events needs-you,done,steps,actions,error,stuck --done-after 30`. The Claude Code plugin follows the same choices.
- **Every action, live**: what the agent is running right now, in the task's one silent notification, at most twice a minute.
- ntfy.sh allows 250 notifications a day per network address. When fewer than 50 are left, Kvali pauses the silent updates so alerts still get through.

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
