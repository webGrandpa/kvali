/**
 * Sets the release version everywhere it is written:
 *
 *   node scripts/set-version.mjs 0.6.1
 *
 * then add a CHANGELOG entry, commit, and push the tag v0.6.1 to publish.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(2);
}

// The Claude Code plugin too: Claude Code keeps a plugin installed from GitHub per version,
// so a release reaches those users only under a new version.
for (const file of ['core', 'cli', 'vscode'].map((p) => path.join(ROOT, 'packages', p, 'package.json')).concat(path.join(ROOT, 'packages', 'claude-plugin', '.claude-plugin', 'plugin.json'))) {
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
}
const cli = path.join(ROOT, 'packages', 'cli', 'src', 'index.ts');
const src = await readFile(cli, 'utf8');
if (!/const VERSION = '[^']+';/.test(src)) throw new Error('VERSION constant not found in packages/cli/src/index.ts');
await writeFile(cli, src.replace(/const VERSION = '[^']+';/, `const VERSION = '${version}';`));
console.log(`Version ${version}. Next: a CHANGELOG entry, a commit, then \`git tag v${version} && git push origin v${version}\`.`);
