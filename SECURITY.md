# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/webGrandpa/kvali/security/advisories/new)). Describe the problem, how to reproduce it, and the versions of Kvali, the editor or terminal, and the agent involved.

Reports are answered as soon as possible. A confirmed problem is fixed in a new release on every channel (VS Code Marketplace, Open VSX, npm and GitHub) and credited to you in the advisory, unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release. Editors update the extension on their own; for the CLI, run `npx @kvali/cli@latest` or `npm install -g @kvali/cli@latest`.

## How Kvali keeps your machine safe

- **Local only.** The hook endpoint listens on `127.0.0.1` (port 47821 by default) and refuses requests addressed to any other host name, so a web page cannot reach it through DNS rebinding. It accepts only JSON, and stores no prompts or tool inputs.
- **Read-only toward the agents.** Kvali reads the agents' files and writes only its own files and clearly marked sections that **Turn Off** removes again ([PRIVACY.md](PRIVACY.md) lists them).
- **Hooks never hold an agent up.** They time out within seconds and always report success, even when no Kvali is running.
- **Phone setup.** The topic name is the secret, so Kvali makes an unguessable one; `~/.kvali/config.json` is readable only by your user account; an ntfy access token never reaches the editor's webview.
- **Releases.** The extension and the CLI are self-contained bundles: nothing is downloaded when they run. They include two MIT-licensed libraries ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Every release is built from a version tag by GitHub Actions, and the npm package is published with provenance through npm trusted publishing.

## Scope

In scope: the VS Code extension, the `kvali` CLI (`@kvali/cli`) and the Claude Code plugin in this repository. The agents themselves, ntfy.sh and the ntfy apps are separate projects: please report their problems to them.
