/**
 * Runs when the extension is uninstalled (`vscode:uninstall` in package.json).
 * Removes everything Kvali added: Claude Code hooks and the planning rules in
 * global agent instructions. Nothing of the user's own content is touched.
 */
import os from 'node:os';
import { removeSetup } from '@kvali/core';

void removeSetup(os.homedir(), process.env);
