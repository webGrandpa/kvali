import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTINUE_PROMPT, limitOfOneModel, modelFamily, onPath, resumeCommand } from '../src/resume.ts';

const ID = '3f2a9c1e-0b7d-4e2f-9a51-1c2d3e4f5a6b';

test('Continue resumes the session and sends the message at once, in the model asked for', () => {
  assert.equal(resumeCommand('claude-code', ID), `claude --resume ${ID}`);
  assert.equal(
    resumeCommand('claude-code', ID, { prompt: CONTINUE_PROMPT, model: 'claude-opus-5-5' }),
    `claude --resume ${ID} --model "claude-opus-5-5" "Continue where you left off. If a command was cut off when you stopped, run it again."`,
  );
  assert.equal(resumeCommand('claude-code', ID, { model: 'claude-fable-5-2[1m]' }), `claude --resume ${ID} --model "claude-fable-5-2[1m]"`);
  assert.equal(resumeCommand('codex', ID), `codex resume ${ID}`);
});

test('Nothing from a session file reaches the shell unchecked', () => {
  assert.equal(resumeCommand('claude-code', 'x; rm -rf ~'), undefined);
  assert.equal(resumeCommand('claude-code', ID, { model: 'opus; curl evil' }), `claude --resume ${ID}`, 'a model name with shell characters is left out');
  assert.equal(resumeCommand('claude-code', ID, { prompt: 'Go on "$(whoami)" `id` !!' }), `claude --resume ${ID} "Go on (whoami) id "`);
  assert.equal(resumeCommand('cline', ID), undefined);
});

test('Which limits bind one model, and the family of a model', () => {
  assert.equal(limitOfOneModel('Fable limit'), true);
  assert.equal(limitOfOneModel('Opus limit'), true);
  assert.equal(limitOfOneModel('5-hour limit'), false);
  assert.equal(limitOfOneModel('weekly limit'), false);
  assert.equal(modelFamily('claude-fable-5-2'), 'fable');
  assert.equal(modelFamily('claude-opus-5-5[1m]'), 'opus');
  assert.equal(modelFamily('gpt-6.2'), undefined);
});

test('onPath finds a command as a shell would, also npm\'s Windows shims', () => {
  const posix = { PATH: '/usr/bin:/home/u/.npm-global/bin' };
  assert.equal(onPath('codex', posix, 'darwin', (f) => f === '/home/u/.npm-global/bin/codex'), true);
  assert.equal(onPath('codex', posix, 'linux', () => false), false);
  const win = { Path: 'C:\\Windows\\system32;"C:\\Users\\u\\AppData\\Roaming\\npm"', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(onPath('codex', win, 'win32', (f) => f === 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd'), true);
  assert.equal(onPath('codex', win, 'win32', (f) => f === 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.ps1'), true);
  // npm's extensionless shim is for sh: PowerShell and cmd do not run it.
  assert.equal(onPath('codex', win, 'win32', (f) => f === 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex'), false);
  assert.equal(onPath('codex', {}, 'win32', () => true), false);
});
