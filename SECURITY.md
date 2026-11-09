# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/webGrandpa/kvali/security/advisories/new)). Describe the problem, how to reproduce it, and the versions of Kvali, the editor or terminal, and the agent involved.

Reports are answered as soon as possible. A confirmed problem is fixed in a new release on every channel (VS Code Marketplace, Open VSX, npm and GitHub) and credited to you in the advisory, unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release. Editors update the extension on their own; for the CLI, run `npx @kvali/cli@latest` or `npm install -g @kvali/cli@latest`.

## How Kvali keeps your machine safe

- **Local only.** The hook endpoint listens on `127.0.0.1` (port 47821 by default). It refuses requests addressed to any other host name and requests a browser marks as sent by a web page (`Origin`, `Sec-Fetch-Site`), so a page can neither reach it through DNS rebinding nor post to it directly. It accepts only `application/json`, stores no prompts or tool inputs, and drops slow or idle connections.
- **Read-only toward the agents.** Kvali reads the agents' files and writes only its own files and clearly marked sections that **Turn Off** removes again ([PRIVACY.md](PRIVACY.md) lists them). It removes only what lies between its own start and end markers, outside code blocks, and replaces a file whole (written beside it, then renamed), keeping its permissions and any link to it.
- **Files are data.** Text from agents' files and from projects (`.agents/progress.md`) is only shown: terminal escape sequences, control characters and invisible or direction-changing characters are removed first, long lines and large files are skipped, and every pattern Kvali matches runs in linear time. A project's progress file is read only from inside the project, and one record Kvali cannot read leaves out that record, not the session.
- **Hooks never hold an agent up.** They time out within seconds and always report success, even when no Kvali is running.
- **Phone setup.** The topic name is the secret, so Kvali makes an unguessable one; `~/.kvali` is readable only by your user account; an ntfy access token never reaches the editor's webview. A Telegram bot is paired with the chat that sends it a one-time code, after you confirm the chat's name. Notifications never contain command lines, and for a project's progress file they carry neither its note nor an agent name that is more than a short name.
- **Settings a project cannot change.** The hook port, the folders Kvali reads Antigravity's plans from, automatic plans, prices, the agents turned off and the polling interval are user settings only: a repository's `.vscode/settings.json` cannot set them. Kvali opens folders and starts terminals only in local folders that exist, never on a network share.
- **Releases.** The extension and the CLI are self-contained bundles: nothing is downloaded when they run. They include two MIT-licensed libraries ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Every release is built from a version tag by GitHub Actions, with every action pinned to a commit, and the npm package is published with provenance through npm trusted publishing.

## Scope

In scope: the VS Code extension, the `kvali` CLI (`@kvali/cli`) and the Claude Code plugin in this repository. The agents themselves, ntfy.sh and the ntfy apps are separate projects: please report their problems to them.
