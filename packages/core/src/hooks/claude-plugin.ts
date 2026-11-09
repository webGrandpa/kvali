/**
 * Kvali's Claude Code plugin, installed the way Claude Code installs any plugin.
 *
 * Kvali keeps a copy of the plugin in `~/.kvali/claude-plugin`. That folder is a plugin
 * marketplace of its own, and Claude Code reads a folder marketplace's plugin in place, so
 * when Kvali updates the folder, new sessions run the new plugin with nothing to reinstall.
 * Registering and enabling it is done by Claude Code's own `claude plugin` command; Kvali
 * never writes Claude Code's plugin files by hand (except to forget its entry when the
 * command is gone at uninstall time).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsc, promises as fsp } from 'node:fs';
import path from 'node:path';

export const CLAUDE_PLUGIN_ID = 'kvali@kvali';
export const CLAUDE_MARKETPLACE = 'kvali';

type Env = Record<string, string | undefined>;

export const kvaliPluginDir = (home: string): string => path.join(home, '.kvali', 'claude-plugin');
const stateFile = (home: string) => path.join(home, '.kvali', 'state.json');

async function filesUnder(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Claude Code writes its type files into a plugin folder it loads; they are not the plugin.
      if (path.relative(base, full) === path.join('.claude-plugin', 'types')) continue;
      out.push(...(await filesUnder(full, base)));
    } else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
}

/** A fingerprint of a plugin folder: every file's path and content. */
export async function pluginFingerprint(dir: string): Promise<string | undefined> {
  const files = await filesUnder(dir);
  if (!files.length) return undefined;
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.split(path.sep).join('/'));
    h.update('\0');
    h.update(await fsp.readFile(path.join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** The plugin's version from its manifest, e.g. "0.7.1". */
export async function pluginVersion(dir: string): Promise<string | undefined> {
  try {
    const v = (JSON.parse(await fsp.readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Compares "x.y.z" versions: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * Puts the plugin that ships with Kvali into `~/.kvali/claude-plugin` when that folder
 * differs from it (first setup, or Kvali was updated). Returns whether anything changed.
 * A newer plugin is never replaced by an older one: with Kvali in two editors, the one not
 * yet updated would otherwise put its older plugin back each time it starts.
 */
export async function syncClaudePlugin(bundledDir: string, home: string): Promise<boolean> {
  const target = kvaliPluginDir(home);
  const [want, have] = await Promise.all([pluginFingerprint(bundledDir), pluginFingerprint(target)]);
  if (!want) throw new Error(`the Claude Code plugin is missing from ${bundledDir}`);
  if (want === have) return false;
  const [mine, theirs] = await Promise.all([pluginVersion(bundledDir), pluginVersion(target)]);
  if (mine && theirs && compareVersions(mine, theirs) < 0) return false;
  const next = `${target}.next`;
  await fsp.rm(next, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(bundledDir, next, { recursive: true });
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(next, target);
  return true;
}

/** Folders of the Claude Code editor extension in VS Code and its forks, newest first. */
export async function claudeExtensionDirs(home: string): Promise<string[]> {
  const roots = ['.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.windsurf', '.antigravity', '.antigravity-ide', '.kiro'].map((d) =>
    path.join(home, d, 'extensions'),
  );
  const found: string[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await fsp.readdir(root);
    } catch {
      continue;
    }
    for (const n of names) if (n.toLowerCase().startsWith('anthropic.claude-code-')) found.push(path.join(root, n));
  }
  const ver = (p: string) => (/-(\d+)\.(\d+)\.(\d+)/.exec(path.basename(p)) ?? []).slice(1).map(Number);
  return found.sort((a, b) => {
    const [x, y] = [ver(a), ver(b)];
    for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

/**
 * Finds Claude Code's command: the one inside the Claude Code editor extension (an editor
 * started from the Dock has no shell PATH), then PATH, then the usual install places.
 */
export async function findClaudeBinary(opts: { home: string; env?: Env; extensionDirs?: readonly string[]; platform?: NodeJS.Platform }): Promise<string | undefined> {
  const win = (opts.platform ?? process.platform) === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const candidates: string[] = [];
  for (const d of opts.extensionDirs ?? []) {
    const bin = path.join(d, 'resources', 'native-binary');
    let inside: string[] = [];
    try {
      inside = await fsp.readdir(bin);
    } catch {
      continue;
    }
    // `claude`, or a platform-named build of it; never the extension's other helpers.
    const ranked = inside.filter((n) => /^claude([-.].*)?$/i.test(n) && !/\.(json|md|txt|map)$/i.test(n)).sort((x, y) => x.length - y.length);
    for (const n of ranked) candidates.push(path.join(bin, n));
  }
  for (const dir of (opts.env?.PATH ?? opts.env?.Path ?? '').split(path.delimiter)) if (dir) for (const n of names) candidates.push(path.join(dir, n));
  candidates.push(path.join(opts.home, '.claude', 'local', names[0]!), path.join(opts.home, '.local', 'bin', names[0]!));
  if (!win) candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  for (const c of candidates) {
    try {
      await fsp.access(c, win ? fsc.F_OK : fsc.X_OK);
      if ((await fsp.stat(c)).isFile()) return c;
    } catch {
      // not here
    }
  }
  return undefined;
}

export interface CliResult {
  code: number;
  out: string;
}

/** Runs Claude Code's command with fixed arguments (no shell on macOS and Linux). */
export function runClaude(bin: string, args: readonly string[], env: Env, timeoutMs = 60_000): Promise<CliResult> {
  const cmdShim = process.platform === 'win32' && /\.cmd$/i.test(bin);
  const argv = cmdShim ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : [...args];
  return new Promise((resolve) => {
    execFile(
      cmdShim ? `"${bin}"` : bin,
      argv,
      { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: cmdShim },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
      },
    );
  });
}

function lastLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

export type PluginInstallResult = { ok: true; version?: string } | { ok: false; unsupported: boolean; error: string };

interface ListedPlugin {
  id: string;
  version?: string;
  enabled?: boolean;
  readFromFolder?: string;
}

export async function listedPlugin(bin: string, env: Env): Promise<ListedPlugin | undefined> {
  const r = await runClaude(bin, ['plugin', 'list', '--json'], env);
  if (r.code !== 0) return undefined;
  try {
    const start = r.out.indexOf('[');
    const list = JSON.parse(r.out.slice(start)) as ListedPlugin[];
    return list.find((p) => p.id === CLAUDE_PLUGIN_ID);
  } catch {
    return undefined;
  }
}

/**
 * Registers `dir` as Claude Code's `kvali` marketplace and installs the plugin from it,
 * after Claude Code itself confirms it can load the plugin (`claude plugin validate`):
 * a Claude Code without plugin hooks says no, and Kvali uses its hooks instead.
 */
export async function installClaudePlugin(bin: string, dir: string, env: Env): Promise<PluginInstallResult> {
  const valid = await runClaude(bin, ['plugin', 'validate', dir], env);
  if (valid.code !== 0) return { ok: false, unsupported: true, error: `this Claude Code cannot load the plugin (${lastLine(valid.out) || `exit ${valid.code}`})` };
  const added = await runClaude(bin, ['plugin', 'marketplace', 'add', dir], env);
  if (added.code !== 0 && !/already/i.test(added.out)) return { ok: false, unsupported: false, error: lastLine(added.out) || 'could not add the plugin folder' };
  const installed = await runClaude(bin, ['plugin', 'install', CLAUDE_PLUGIN_ID], env);
  if (installed.code !== 0 && !/already installed/i.test(installed.out)) return { ok: false, unsupported: false, error: lastLine(installed.out) || 'could not install the plugin' };
  const listed = await listedPlugin(bin, env);
  if (!listed) return { ok: false, unsupported: false, error: 'Claude Code does not list the plugin after installing it' };
  if (listed.enabled === false) {
    const enabled = await runClaude(bin, ['plugin', 'enable', CLAUDE_PLUGIN_ID], env);
    if (enabled.code !== 0) return { ok: false, unsupported: false, error: lastLine(enabled.out) || 'could not enable the plugin' };
  }
  return { ok: true, version: listed.version };
}

/** Whether Claude Code's settings enable Kvali's plugin (a cheap check, no command run). */
export async function claudePluginEnabled(settingsFile: string): Promise<boolean> {
  try {
    const s = JSON.parse(await fsp.readFile(settingsFile, 'utf8')) as { enabledPlugins?: Record<string, unknown> };
    return s?.enabledPlugins?.[CLAUDE_PLUGIN_ID] === true;
  } catch {
    return false;
  }
}

interface KvaliState {
  /** Kvali installed its Claude Code plugin (so it may remove it again). */
  claudePlugin?: boolean;
  /** Kvali turned on Claude Code's task-list tools in its settings (so it may turn them off again). */
  claudeTodoTools?: boolean;
}

export async function readKvaliState(home: string): Promise<KvaliState> {
  try {
    return (JSON.parse(await fsp.readFile(stateFile(home), 'utf8')) as KvaliState) ?? {};
  } catch {
    return {};
  }
}

export async function writeKvaliState(home: string, patch: Partial<KvaliState>): Promise<void> {
  const next = { ...(await readKvaliState(home)), ...patch };
  await fsp.mkdir(path.dirname(stateFile(home)), { recursive: true });
  await fsp.writeFile(stateFile(home), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Removes the plugin Kvali installed: through Claude Code's command when it can be found,
 * otherwise by taking Kvali's two entries out of Claude Code's settings. A `kvali`
 * marketplace someone added from elsewhere (GitHub) is left alone.
 */
export async function removeClaudePlugin(opts: { home: string; env: Env; settingsFile: string; bin?: string }): Promise<boolean> {
  const state = await readKvaliState(opts.home);
  if (!state.claudePlugin) return false;
  const dir = kvaliPluginDir(opts.home);
  if (opts.bin) {
    await runClaude(opts.bin, ['plugin', 'uninstall', CLAUDE_PLUGIN_ID], opts.env);
    const list = await runClaude(opts.bin, ['plugin', 'marketplace', 'list', '--json'], opts.env);
    try {
      const mk = (JSON.parse(list.out.slice(list.out.indexOf('['))) as { name: string; path?: string }[]).find((m) => m.name === CLAUDE_MARKETPLACE);
      if (mk && mk.path && path.resolve(mk.path) === path.resolve(dir)) await runClaude(opts.bin, ['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE], opts.env);
    } catch {
      // nothing listed
    }
  } else {
    try {
      const raw = await fsp.readFile(opts.settingsFile, 'utf8');
      const s = JSON.parse(raw) as { enabledPlugins?: Record<string, unknown>; extraKnownMarketplaces?: Record<string, { source?: { path?: string } }> };
      let changed = false;
      if (s.enabledPlugins && CLAUDE_PLUGIN_ID in s.enabledPlugins) {
        delete s.enabledPlugins[CLAUDE_PLUGIN_ID];
        changed = true;
      }
      const mk = s.extraKnownMarketplaces?.[CLAUDE_MARKETPLACE];
      if (mk?.source?.path && path.resolve(mk.source.path) === path.resolve(dir)) {
        delete s.extraKnownMarketplaces![CLAUDE_MARKETPLACE];
        changed = true;
      }
      if (changed) await fsp.writeFile(opts.settingsFile, `${JSON.stringify(s, null, 2)}\n`);
    } catch {
      // no settings
    }
  }
  await fsp.rm(dir, { recursive: true, force: true });
  await writeKvaliState(opts.home, { claudePlugin: false });
  return true;
}
