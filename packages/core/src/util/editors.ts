/**
 * Where VS Code and the editors built on it keep their extensions' data.
 *
 * Every extension gets a folder under `<userData>/User/globalStorage/<publisher.name>` (named in
 * lower case), and editor profiles may have their own under `User/profiles/<id>/globalStorage`.
 * `<userData>` depends on the editor and the OS; a remote window (SSH, WSL, containers) keeps
 * its extensions' data on the remote machine, under `~/.<editor>-server/data`.
 */
import path from 'node:path';

/** Folder names of `<userData>` for VS Code and the editors built on it. */
export const EDITOR_APPS = [
  'Code',
  'Code - Insiders',
  'Code - OSS',
  'VSCodium',
  'VSCodium - Insiders',
  'Cursor',
  'Windsurf',
  'Windsurf - Next',
  'Antigravity',
  'Trae',
  'Kiro',
  'Positron',
  'Void',
] as const;

/** Remote servers keep their data in `~/<folder>/data`. */
const SERVER_DIRS = [
  '.vscode-server',
  '.vscode-server-insiders',
  '.vscodium-server',
  '.cursor-server',
  '.windsurf-server',
  '.antigravity-server',
  '.trae-server',
  '.kiro-server',
  '.positron-server',
];

/**
 * The `<userData>` folders to look in, most likely first. They need not exist. `VSCODE_PORTABLE`
 * (a portable install) comes first when set.
 */
export function editorUserDataDirs(home: string, env: Record<string, string | undefined>, platform: string = process.platform): string[] {
  const out: string[] = [];
  if (env.VSCODE_PORTABLE) out.push(path.join(env.VSCODE_PORTABLE, 'user-data'));
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  for (const app of EDITOR_APPS) out.push(path.join(base, app));
  for (const dir of SERVER_DIRS) out.push(path.join(home, dir, 'data'));
  return out;
}

/** `<userData>/User/globalStorage` of each editor (see `editorUserDataDirs`). */
export function editorGlobalStorageDirs(home: string, env: Record<string, string | undefined>, platform: string = process.platform): string[] {
  return editorUserDataDirs(home, env, platform).map((d) => path.join(d, 'User', 'globalStorage'));
}
