import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_PROCESS, childrenOf, descendants, isAncestor, parsePs, processTable } from '../src/processes.ts';

const PS = `
    1     0 /sbin/launchd
  500     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  610   500 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility
  700   610 /bin/zsh -il
  701   700 claude --resume 3f2a
  702   701 /bin/zsh -c -l source /Users/me/.claude/shell-snapshots/snapshot.sh && pnpm test
  800   610 /bin/zsh -il
  801   800 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js
  802   801 /usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex-aarch64-apple-darwin
  900   610 /bin/bash
  901   900 vim notes.md
`;

test('process table: parents, children, ancestors', () => {
  const t = parsePs(PS);
  assert.equal(t.size, 11);
  assert.equal(t.get(701)?.args, 'claude --resume 3f2a');
  const kids = childrenOf(t);
  assert.deepEqual(descendants(kids, 700).map((p) => p.pid).sort(), [701, 702]);
  assert.ok(isAncestor(t, 700, 702));
  assert.ok(!isAncestor(t, 800, 702));
});

test('agent processes are recognized by their command lines', () => {
  const t = parsePs(PS);
  const is = (agent: string, pid: number) => AGENT_PROCESS[agent]!.test(t.get(pid)!.args);
  assert.ok(is('claude-code', 701));
  assert.ok(!is('claude-code', 702), 'a shell Claude Code started is not Claude Code');
  assert.ok(is('codex', 801));
  assert.ok(is('codex', 802));
  assert.ok(!is('codex', 901));
  assert.ok(AGENT_PROCESS.copilot!.test('node /opt/homebrew/lib/node_modules/@github/copilot/npm-loader.js'));
  assert.ok(AGENT_PROCESS.opencode!.test('/Users/me/.opencode/bin/opencode'));
  assert.ok(AGENT_PROCESS['gemini-cli']!.test('node /usr/local/bin/gemini'));
  assert.ok(!AGENT_PROCESS['gemini-cli']!.test('node /work/gemini-notes/index.js'));
});

test('this computer: the process table includes this process', async () => {
  const t = await processTable();
  assert.ok(t.size > 0);
  assert.ok(t.has(process.pid));
});
