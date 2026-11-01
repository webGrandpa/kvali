import { copyFile, mkdir, rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';
import { copyClaudePlugin } from '../../scripts/copy-claude-plugin.mjs';
import { checkNotices } from '../../scripts/third-party.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'warning',
  },
  {
    entryPoints: ['src/uninstall.ts'],
    outfile: 'dist/uninstall.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify: production,
    logLevel: 'warning',
  },
  {
    entryPoints: ['webview/main.tsx'],
    outfile: 'dist/webview/main.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcemap: !production,
    minify: production,
    logLevel: 'warning',
  },
];

if (production) {
  // Bundled open-source code must be credited: stop when THIRD_PARTY_NOTICES.md misses a package.
  await checkNotices();
  await rm('dist', { recursive: true, force: true });
  // The Marketplace page shows the repository's changelog.
  await copyFile('../../CHANGELOG.md', 'CHANGELOG.md');
  await copyFile('../../THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md');
}
await mkdir('dist/webview', { recursive: true });
await copyFile('webview/styles.css', 'dist/webview/main.css');
// The Claude Code plugin ships inside the extension; Turn on installs it.
await copyClaudePlugin('dist/claude-plugin');

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
