import { copyFile, mkdir, rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

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

if (production) await rm('dist', { recursive: true, force: true });
await mkdir('dist/webview', { recursive: true });
await copyFile('webview/styles.css', 'dist/webview/main.css');

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
