import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { claudeHookReply, pluginRunsIn } from '../src/hooks/replies.ts';
import { CLAUDE_TODO_TOOLS_ENV, claudeHooksStatus, disableClaudeTodoTools, enableClaudeTodoTools, installClaudeHooks } from '../src/hooks/claude-install.ts';
import { compareVersions, findClaudeBinary, kvaliPluginDir, readKvaliState, syncClaudePlugin } from '../src/hooks/claude-plugin.ts';
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

test('Turn on installs the Claude Code plugin with Claude Code\'s own command and keeps Kvali\'s hooks beside it', async () => {
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
  // For a Claude Code that cannot load the plugin (an older one in another editor reads the same settings).
  assert.equal(await claudeHooksStatus(settings, 47821), 'installed', "Kvali's hooks stay beside the plugin");
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done', "the user's own hooks stay");
  assert.equal((await readKvaliState(home)).claudePlugin, true);
  // Current Claude models get the task-list tools only when asked, and plans need them.
  assert.equal(s.env?.[CLAUDE_TODO_TOOLS_ENV], '1', "Claude Code's task-list tools are turned on");
  await applySetup(home, env, 47821, undefined, { pluginDir: bundled, autoPlan: false });
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).env, undefined, 'automatic plans off: the switch goes again');
  await applySetup(home, env, 47821, undefined, { pluginDir: bundled });
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).env?.[CLAUDE_TODO_TOOLS_ENV], '1');

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
  assert.equal(await claudeHooksStatus(settings, 47821), 'not-installed', "Turn off removes Kvali's hooks too");
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(after.env, undefined, 'and the task-list switch it added');
});

test("Claude Code's task-list switch: Kvali adds it, keeps the person's own value and takes back only its own", async () => {
  const home = tmpHome();
  const settings = path.join(home, '.claude', 'settings.json');
  writeText(settings, JSON.stringify({ env: { FOO: 'bar' } }));
  assert.deepEqual(await enableClaudeTodoTools(settings, home), { changed: true });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).env, { FOO: 'bar', [CLAUDE_TODO_TOOLS_ENV]: '1' });
  assert.equal((await readKvaliState(home)).claudeTodoTools, true);
  assert.deepEqual(await enableClaudeTodoTools(settings, home), { changed: false }, 'already on: the file is left alone');
  assert.deepEqual(await disableClaudeTodoTools(settings, home), { changed: true });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).env, { FOO: 'bar' }, "the person's other variables stay");
  assert.deepEqual(await disableClaudeTodoTools(settings, home), { changed: false });

  // Set by the person, on or off: Kvali neither changes nor removes it.
  const own = tmpHome();
  const ownSettings = path.join(own, '.claude', 'settings.json');
  writeText(ownSettings, JSON.stringify({ env: { [CLAUDE_TODO_TOOLS_ENV]: '0' } }));
  assert.deepEqual(await enableClaudeTodoTools(ownSettings, own), { changed: false });
  assert.deepEqual(await disableClaudeTodoTools(ownSettings, own), { changed: false });
  assert.equal(JSON.parse(readFileSync(ownSettings, 'utf8')).env[CLAUDE_TODO_TOOLS_ENV], '0');

  // No settings file yet: created with the switch, and an emptied env goes away again.
  const fresh = tmpHome();
  const freshSettings = path.join(fresh, '.claude', 'settings.json');
  assert.deepEqual(await enableClaudeTodoTools(freshSettings, fresh), { changed: true });
  await disableClaudeTodoTools(freshSettings, fresh);
  assert.deepEqual(JSON.parse(readFileSync(freshSettings, 'utf8')), {});
});

test('An older Kvali never puts its older plugin over a newer one (Kvali in two editors, one not updated yet)', async () => {
  const home = tmpHome();
  const newer = bundledPlugin(path.join(home, 'vscode', 'claude-plugin'), '0.7.1');
  const older = bundledPlugin(path.join(home, 'cursor', 'claude-plugin'), '0.7.0');
  writeText(path.join(older, 'hooks', 'register.tsx'), 'export const register = () => { /* 0.7.0 */ }\n');
  assert.equal(await syncClaudePlugin(newer, home), true);
  assert.equal(await syncClaudePlugin(older, home), false, 'the older bundle leaves the newer plugin in place');
  assert.doesNotMatch(readFileSync(path.join(kvaliPluginDir(home), 'hooks', 'register.tsx'), 'utf8'), /0\.7\.0/);
  const next = bundledPlugin(path.join(home, 'vscode2', 'claude-plugin'), '0.8.0');
  assert.equal(await syncClaudePlugin(next, home), true, 'a newer one replaces it');
  assert.ok(compareVersions('0.7.0', '0.7.1') < 0 && compareVersions('0.10.0', '0.9.9') > 0 && compareVersions('1.2.3', '1.2.3') === 0);
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
