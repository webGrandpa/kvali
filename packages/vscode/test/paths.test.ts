import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isNetworkPath, isWorkspaceRoot, SAFE_ID, safeFile, safeFolder } from '../src/paths.ts';
import { windowFile } from '../src/windows.ts';

test('Only local folders and files that exist are opened, never a network share', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kvali-paths-'));
  const file = path.join(dir, 'a.jsonl');
  writeFileSync(file, '{}\n');
  assert.equal(await safeFolder(dir), dir);
  assert.equal(await safeFolder(file), undefined, 'a file is not a folder');
  assert.equal(await safeFile(file), file);
  assert.equal(await safeFolder(path.join(dir, 'gone')), undefined);
  assert.equal(await safeFolder('relative/dir'), undefined);
  assert.equal(await safeFolder(undefined), undefined);
  assert.equal(isNetworkPath('\\\\attacker.example\\share'), true);
  assert.equal(isNetworkPath('//attacker.example/share'), true);
  assert.equal(await safeFolder('//attacker.example/share'), undefined);
  assert.equal(isNetworkPath('/Users/ana/shop'), false);
});

test('Session ids handed to a command line or another extension are plain ids', () => {
  assert.ok(SAFE_ID.test('3f2a9c1e-0b7d-4e2f-9a51-1c2d3e4f5a6b'));
  assert.ok(!SAFE_ID.test('x; rm -rf ~'));
  assert.ok(!SAFE_ID.test('$(whoami)-aaaaaaaa'));
});

test("Another window's heartbeat: well-formed, its own folders only, never a disk's root", () => {
  const ok = windowFile({ id: '123-abc', roots: ['/Users/ana/shop', '/', 'relative', 7, '//server/share'], workspaceFile: '/Users/ana/all.code-workspace', at: 5 });
  assert.deepEqual(ok, { id: '123-abc', roots: ['/Users/ana/shop'], workspaceFile: '/Users/ana/all.code-workspace', at: 5 });
  assert.equal(windowFile({ id: '../x', roots: [], at: 1 }), undefined);
  assert.equal(windowFile({ id: 'a', roots: '/Users', at: 1 }), undefined, 'roots must be a list');
  assert.equal(windowFile(null), undefined);
  assert.equal(windowFile({ id: 'a', roots: [], workspaceFile: '/etc/passwd', at: 1 })?.workspaceFile, undefined);
  assert.equal(isWorkspaceRoot('/'), false);
});
