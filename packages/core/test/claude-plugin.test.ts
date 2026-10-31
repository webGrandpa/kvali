import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { claudeHookReply, pluginRunsIn } from '../src/hooks/replies.ts';
import { claudeHooksStatus, installClaudeHooks } from '../src/hooks/claude-install.ts';
import { findClaudeBinary, kvaliPluginDir, readKvaliState } from '../src/hooks/claude-plugin.ts';
import { applySetup, removeSetup } from '../src/setup.ts';
import { tmpHome, writeText } from './helpers.ts';

/**
 * A stand-in for Claude Code's `claude` command: it logs each call and keeps the plugin's
 * state in settings.json the way the real one does.
 */
function fakeClaude(dir: string, opts: { validate?: number } = {}): { log: () => string[] } {
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'calls.log');
  const script = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const file = path.join(cfg, 'settings.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const write = (s) => { fs.mkdirSync(cfg, { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2)); };
const cmd = args.slice(0, 3).join(' ');
if (args[1] === 'validate') { if (${opts.validate ?? 0}) { console.log('× Found 1 error: modules is not a known key'); process.exit(${opts.validate ?? 0}); } console.log('√ Validation passed'); }
else if (cmd.startsWith('plugin marketplace add')) { const s = read(); s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, kvali: { source: { source: 'directory', path: args[3] } } }; write(s); console.log('√ Successfully added marketplace: kvali'); }
else if (cmd === 'plugin install kvali@kvali') { const s = read(); s.enabledPlugins = { ...s.enabledPlugins, 'kvali@kvali': true }; write(s); console.log('√ Successfully installed plugin: kvali@kvali'); }
else if (cmd === 'plugin list --json') { const on = read().enabledPlugins?.['kvali@kvali']; console.log(JSON.stringify(on ? [{ id: 'kvali@kvali', version: '0.2.0', enabled: true }] : [])); }
else if (cmd === 'plugin uninstall kvali@kvali') { const s = read(); delete s.enabledPlugins['kvali@kvali']; write(s); console.log('√ Successfully uninstalled plugin: kvali'); }
else if (cmd === 'plugin marketplace list') { const m = read().extraKnownMarketplaces?.kvali; console.log(JSON.stringify(m ? [{ name: 'kvali', source: 'directory', path: m.source.path }] : [])); }
else if (cmd === 'plugin marketplace remove') { const s = read(); delete s.extraKnownMarketplaces.kvali; write(s); console.log('√ Successfully removed marketplace: kvali'); }
else { console.error('unknown: ' + args.join(' ')); process.exit(2); }
`;
  const bin = path.join(dir, 'claude');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

function bundledPlugin(dir: string, version = '0.2.0'): string {
  writeText(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kvali', version }));
  writeText(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'kvali', owner: { name: 'x' }, plugins: [{ name: 'kvali', source: './' }] }));
  writeText(path.join(dir, 'hooks', 'hooks.json'), '{ "modules": ["./register.tsx"] }');
  writeText(path.join(dir, 'hooks', 'register.tsx'), 'export const register = () => {}\n');
  return dir;
}

test('Turn on installs the Claude Code plugin with Claude Code\'s own command and drops Kvali\'s hooks', async () => {
  const home = tmpHome();
  const settings = path.join(home, '.claude', 'settings.json');
  writeText(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  await installClaudeHooks(settings, 47821); // an earlier Kvali set up hooks
  const fake = fakeClaude(path.join(home, 'bin'));
  const env = { HOME: home, PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` };
  const bundled = bundledPlugin(path.join(home, 'ext', 'dist', 'claude-plugin'));

  const r = await applySetup(home, env, 47821, undefined, { pluginDir: bundled });
  assert.equal(r.claude, 'plugin');
  assert.deepEqual(fake.log().map((l) => l.split(' ').slice(0, 3).join(' ')), ['plugin validate ' + kvaliPluginDir(home), 'plugin marketplace add', 'plugin install kvali@kvali', 'plugin list --json'].map((x) => x.split(' ').slice(0, 3).join(' ')));
  assert.ok(existsSync(path.join(kvaliPluginDir(home), 'hooks', 'register.tsx')), 'the plugin is kept in ~/.kvali/claude-plugin');
  assert.equal(await claudeHooksStatus(settings, 47821), 'not-installed', "Kvali's hooks are gone");
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done', "the user's own hooks stay");
  assert.equal((await readKvaliState(home)).claudePlugin, true);

  // Next start: enabled already, nothing to run. An update only replaces the folder, which Claude Code reads in place.
  const calls = fake.log().length;
  writeText(path.join(bundled, 'hooks', 'register.tsx'), 'export const register = () => { /* 0.3.0 */ }\n');
  assert.equal((await applySetup(home, env, 47821, undefined, { pluginDir: bundled })).claude, 'plugin');
  assert.equal(fake.log().length, calls, 'no command needed');
  assert.match(readFileSync(path.join(kvaliPluginDir(home), 'hooks', 'register.tsx'), 'utf8'), /0\.3\.0/);

  // Turn off removes what Kvali added, through the same command.
  await removeSetup(home, env);
  assert.ok(fake.log().some((l) => l === 'plugin uninstall kvali@kvali'));
  assert.ok(fake.log().some((l) => l === 'plugin marketplace remove kvali'));
  assert.ok(!existsSync(kvaliPluginDir(home)));
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual([after.enabledPlugins, after.extraKnownMarketplaces], [{}, {}]);
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'say done');
});

test('Claude Code that cannot load the plugin, or no claude command at all: Kvali uses its hooks', async () => {
  const home = tmpHome();
  writeText(path.join(home, '.claude', 'settings.json'), '{}');
  const bundled = bundledPlugin(path.join(home, 'ext', 'claude-plugin'));
  fakeClaude(path.join(home, 'old'), { validate: 1 });
  const old = await applySetup(home, { HOME: home, PATH: path.join(home, 'old') }, 47821, undefined, { pluginDir: bundled });
  assert.equal(old.claude, 'hooks');
  assert.match(old.claudeNote ?? '', /cannot load the plugin/);
  assert.equal(await claudeHooksStatus(path.join(home, '.claude', 'settings.json'), 47821), 'installed');

  const bare = tmpHome();
  writeText(path.join(bare, '.claude', 'settings.json'), '{}');
  const none = await applySetup(bare, { HOME: bare, PATH: '' }, 47821, undefined, { pluginDir: bundled });
  assert.deepEqual([none.claude, none.claudeNote], ['hooks', "Claude Code's command was not found"]);
});

test("Claude Code's command is found inside its editor extension first", async () => {
  const home = tmpHome();
  const ext = path.join(home, '.antigravity-ide', 'extensions', 'anthropic.claude-code-2.1.316-darwin-arm64');
  const inExt = path.join(ext, 'resources', 'native-binary', 'claude');
  writeText(inExt, '#!/bin/sh\n');
  chmodSync(inExt, 0o755);
  fakeClaude(path.join(home, 'bin'));
  assert.equal(await findClaudeBinary({ home, env: { PATH: path.join(home, 'bin') }, extensionDirs: [ext], platform: 'linux' }), inExt);
  assert.equal(await findClaudeBinary({ home, env: { PATH: path.join(home, 'bin') }, platform: 'linux' }), path.join(home, 'bin', 'claude'));
  assert.equal(await findClaudeBinary({ home, env: { PATH: '' }, platform: 'linux' }), undefined);
});

test('the hook hub leaves planning to the plugin where it runs', () => {
  const live = tmpHome();
  const sid = '0b7c4f9e-1111-4a2b-9c3d-5e6f7a8b9c0d';
  const ev = { sessionId: sid, event: 'UserPromptSubmit', at: 0 };
  assert.equal(pluginRunsIn(live, sid), false);
  assert.ok(claudeHookReply(ev, undefined, pluginRunsIn(live, sid)));
  writeText(path.join(live, 'claude-code', `${sid}.mod.json`), '{}');
  assert.equal(pluginRunsIn(live, sid), true);
  assert.equal(claudeHookReply(ev, undefined, pluginRunsIn(live, sid)), undefined);
  assert.equal(pluginRunsIn(live, '../../etc/passwd'), false);
});
