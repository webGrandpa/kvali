# Contributing to Kvali

Thanks for helping! The most valuable contributions are **new agent adapters** and **fixes for agent format changes**.

## Setup

```bash
git clone https://github.com/webGrandpa/kvali.git
cd kvali
pnpm install        # Node ≥ 22.18, pnpm 10
pnpm test
pnpm build
```

| Package | What it is |
| --- | --- |
| `packages/core` | Engine, adapters, pricing, hook hub. Pure Node with one small runtime dependency (qrcode-generator, MIT). Tests run on `node:test` with built-in TypeScript type stripping. |
| `packages/vscode` | The editor extension (esbuild bundle) and its Preact webview. |
| `packages/cli` | The `kvali` terminal dashboard. |

## Working on the extension

1. `pnpm build` once.
2. Open the repository in VS Code and press <kbd>F5</kbd> (**Run Kvali Extension**). An Extension Development Host opens with Kvali loaded; `pnpm --filter kvali watch` rebuilds on save.
3. `pnpm package` produces `packages/vscode/kvali-<version>.vsix`.

## Working on the Claude Code plugin

`packages/claude-plugin` is a Claude Code plugin with function hooks (no build step). Check it with Claude Code itself:

```bash
claude plugin validate packages/claude-plugin
claude plugin test packages/claude-plugin
```

To try it live, run `claude --plugin-dir packages/claude-plugin`: saving a file reloads it.

## Pull requests

- Keep adapters read-only, local and cheap (see [docs/ADAPTERS.md](docs/ADAPTERS.md)).
- Add or update tests; `pnpm test` and `pnpm typecheck` must pass.
- Never commit real transcripts. Build fixtures in test code and strip anything private.
- Describe which agent version you verified against.

## Licensing

- By contributing, you agree that your contribution is released under the project's [MIT License](LICENSE). Only submit code you wrote or may license that way.
- A new dependency that ends up in a bundle needs a permissive license (MIT, ISC, BSD or Apache-2.0) and its own section in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `node scripts/third-party.mjs` checks this, and the release build runs it.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Reporting a format change

Agents change their files often. If Kvali shows wrong progress or tokens, open an issue with the agent name and version, what Kvali shows, what you expected, and a sanitized snippet of the relevant lines.

## Releases

See [RELEASING.md](RELEASING.md): one version tag publishes the extension, the CLI and the GitHub release.
