/**
 * Open-source code that Kvali bundles must be credited. This lists the npm packages inside
 * the builds (the extension, its uninstall hook, its webview and the CLI) and checks each
 * one against THIRD_PARTY_NOTICES.md: listed with its version (`## <name> <version>`), under
 * a license that allows bundling. The extension's release build runs it and stops on a gap.
 *
 *   node scripts/third-party.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VSCODE = path.join(ROOT, 'packages', 'vscode');
/** Permissive licenses whose terms the notices file satisfies. Anything else needs a review first. */
const PERMISSIVE = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);

const BUILDS = [
  { entryPoints: [path.join(VSCODE, 'src', 'extension.ts')], platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: [path.join(VSCODE, 'src', 'uninstall.ts')], platform: 'node', format: 'cjs' },
  { entryPoints: [path.join(VSCODE, 'webview', 'main.tsx')], platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact' },
  { entryPoints: [path.join(ROOT, 'packages', 'cli', 'src', 'index.ts')], platform: 'node', format: 'esm' },
];

/** The npm packages the builds contain: `{ name, version, license }`. */
export async function bundledPackages() {
  const dirs = new Set();
  for (const b of BUILDS) {
    const r = await esbuild.build({ ...b, bundle: true, write: false, metafile: true, outdir: path.join(ROOT, 'out', 'third-party'), absWorkingDir: ROOT, logLevel: 'silent' });
    for (const input of Object.keys(r.metafile.inputs)) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
      if (m) dirs.add(m[1]);
    }
  }
  const found = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(await readFile(path.join(ROOT, dir, 'package.json'), 'utf8'));
    found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Throws when a bundled package is missing from THIRD_PARTY_NOTICES.md or needs a license review. */
export async function checkNotices() {
  const notices = (await readFile(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')).replace(/\r\n/g, '\n');
  const packages = await bundledPackages();
  const problems = [];
  for (const p of packages) {
    if (!PERMISSIVE.has(p.license)) problems.push(`${p.name} ${p.version}: license "${p.license}" needs a review before it is bundled`);
    if (!notices.includes(`\n## ${p.name} ${p.version}\n`)) problems.push(`${p.name} ${p.version} is bundled but THIRD_PARTY_NOTICES.md has no "## ${p.name} ${p.version}" section`);
  }
  if (problems.length) throw new Error(`Third-party notices are out of date:\n- ${problems.join('\n- ')}`);
  return packages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = await checkNotices();
  console.log(`THIRD_PARTY_NOTICES.md covers every bundled package: ${packages.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}`);
}
