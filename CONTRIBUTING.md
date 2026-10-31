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
| `packages/core` | Engine, adapters, pricing, hook hub. Pure Node, no runtime dependencies. Tests run on `node:test` with built-in TypeScript type stripping. |
| `packages/vscode` | The editor extension (esbuild bundle) and its Preact webview. |
| `packages/cli` | The `kvali` terminal dashboard. |

## Working on the extension

1. `pnpm build` once.
2. Open the repository in VS Code and press <kbd>F5</kbd> (**Run Kvali Extension**). An Extension Development Host opens with Kvali loaded; `pnpm --filter kvali watch` rebuilds on save.
3. `pnpm package` produces `packages/vscode/kvali-<version>.vsix`.

## Pull requests

- Keep adapters read-only, local and cheap (see [docs/ADAPTERS.md](docs/ADAPTERS.md)).
- Add or update tests; `pnpm test` and `pnpm typecheck` must pass.
- Never commit real transcripts. Build fixtures in test code and strip anything private.
- Describe which agent version you verified against.

## Reporting a format change

Agents change their files often. If Kvali shows wrong progress or tokens, open an issue with the agent name and version, what Kvali shows, what you expected, and a sanitized snippet of the relevant lines.
