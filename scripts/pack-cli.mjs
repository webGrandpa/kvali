/**
 * Assembles the npm package `@kvali/cli` (command: `kvali`) in packages/cli/npm-package from
 * the built CLI: a clean manifest with no workspace references. npm refuses the plain name
 * `kvali` as too close to an existing package, so the CLI lives in the project's scope.
 *
 *   pnpm build && node scripts/pack-cli.mjs
 *   npm publish packages/cli/npm-package --access public
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'packages', 'cli');
const OUT = path.join(CLI, 'npm-package');

const src = JSON.parse(await readFile(path.join(CLI, 'package.json'), 'utf8'));
for (const f of ['dist/kvali.mjs', 'dist/claude-plugin/.claude-plugin/plugin.json']) {
  await stat(path.join(CLI, f)).catch(() => {
    throw new Error(`${f} is missing: run \`pnpm build\` first`);
  });
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(path.join(CLI, 'dist'), path.join(OUT, 'dist'), { recursive: true });
await cp(path.join(CLI, 'README.md'), path.join(OUT, 'README.md'));
await cp(path.join(CLI, 'LICENSE'), path.join(OUT, 'LICENSE'));

const manifest = {
  name: src.name,
  version: src.version,
  description: 'Live progress, tokens and phone alerts for AI coding agents (Claude Code, Codex, Gemini CLI, Antigravity), in your terminal.',
  license: 'MIT',
  author: 'Giorgi Khiladze (https://github.com/webGrandpa)',
  homepage: 'https://github.com/webGrandpa/kvali#readme',
  repository: { type: 'git', url: 'git+https://github.com/webGrandpa/kvali.git', directory: 'packages/cli' },
  bugs: { url: 'https://github.com/webGrandpa/kvali/issues' },
  bin: { kvali: 'dist/kvali.mjs' },
  files: ['dist'],
  engines: { node: '>=20' },
  keywords: src.keywords,
  publishConfig: { access: 'public' },
};
await writeFile(path.join(OUT, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`packages/cli/npm-package: ${manifest.name}@${manifest.version}`);
