/**
 * Copies Kvali's Claude Code plugin into a build (the editor extension and the CLI ship it)
 * as a folder Claude Code can use as a marketplace: plugin.json and marketplace.json side by side.
 *
 *   node scripts/copy-claude-plugin.mjs <out dir>
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'claude-plugin');
const FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'hooks/model.ts', 'types/index.d.ts', 'README.md', 'LICENSE'];

export async function copyClaudePlugin(out) {
  await rm(out, { recursive: true, force: true });
  for (const f of FILES) {
    await mkdir(path.dirname(path.join(out, f)), { recursive: true });
    await cp(path.join(SRC, f), path.join(out, f));
  }
  const manifest = JSON.parse(await readFile(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = {
    name: 'kvali',
    owner: manifest.author ?? { name: 'Kvali' },
    plugins: [{ name: manifest.name, source: './', description: manifest.description }],
  };
  await writeFile(path.join(out, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: copy-claude-plugin.mjs <out dir>');
  await copyClaudePlugin(path.resolve(process.argv[2]));
}
