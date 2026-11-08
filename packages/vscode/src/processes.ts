/**
 * The processes on this computer, read when you ask Kvali to take you to an agent (never in the
 * background), to find the terminal the agent runs in. The commands run directly, never
 * through a shell, and only read.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import type { AgentId } from '@kvali/core';

/** How each command-line agent shows up in a process list. */
export const AGENT_PROCESS: Partial<Record<AgentId, RegExp>> = {
  'claude-code': /(^|[\\/\s])claude(\.exe)?(\s|$)|@anthropic-ai[\\/]claude-code/i,
  codex: /(^|[\\/\s])codex(\.exe|-[a-z0-9_-]+)?(\s|$)|@openai[\\/]codex/i,
  'gemini-cli': /(^|[\\/\s])gemini(\.exe)?(\s|$)|@google[\\/]gemini-cli/i,
  copilot: /(^|[\\/\s])copilot(\.exe)?(\s|$)|@github[\\/]copilot/i,
  opencode: /(^|[\\/\s])opencode(\.exe)?(\s|$)|opencode-ai/i,
  'kilo-code': /(^|[\\/\s])kilo(\.exe)?(\s|$)|@kilocode[\\/]cli/i,
  cline: /(^|[\\/\s])cline(\.exe)?(\s|$)|@cline[\\/]cli/i,
};

export interface Proc {
  pid: number;
  ppid: number;
  /** The command line. */
  args: string;
}

function run(cmd: string, args: string[], timeout = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 << 20, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout)));
  });
}

/** `ps` output: `pid ppid args` per line. */
export function parsePs(out: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), args: m[3].trim() });
  }
  return table;
}

async function fromProc(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>();
  let names: string[] = [];
  try {
    names = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return table;
  }
  await Promise.all(
    names.map(async (n) => {
      try {
        const stat = await fsp.readFile(`/proc/${n}/stat`, 'utf8');
        // "pid (comm) state ppid …": the command name may itself hold spaces and parentheses.
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const cmdline = (await fsp.readFile(`/proc/${n}/cmdline`, 'utf8')).split('\0').filter(Boolean).join(' ');
        table.set(Number(n), { pid: Number(n), ppid: Number(rest[1]), args: cmdline || stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) });
      } catch {
        /* the process ended meanwhile */
      }
    }),
  );
  return table;
}

/** Every process with its parent and command line. Empty when they cannot be read. */
export async function processTable(platform: string = process.platform): Promise<Map<number, Proc>> {
  if (platform === 'win32') {
    const out = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
      10_000,
    );
    const table = new Map<number, Proc>();
    try {
      const rows = JSON.parse(out ?? '[]') as { ProcessId: number; ParentProcessId: number; CommandLine?: string | null }[];
      for (const r of Array.isArray(rows) ? rows : [rows]) table.set(r.ProcessId, { pid: r.ProcessId, ppid: r.ParentProcessId, args: r.CommandLine ?? '' });
    } catch {
      /* no PowerShell, or an unexpected answer */
    }
    return table;
  }
  const out = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']);
  const table = out ? parsePs(out) : new Map<number, Proc>();
  if (table.size === 0 && platform === 'linux') return fromProc();
  return table;
}

/** The working folders of these processes, where the OS tells (Linux, macOS). */
export async function processCwds(pids: readonly number[], platform: string = process.platform): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  if (platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await fsp.readlink(`/proc/${pid}/cwd`));
        } catch {
          /* gone, or not ours */
        }
      }),
    );
    return out;
  }
  if (platform === 'darwin') {
    const text = await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
    let pid: number | undefined;
    for (const line of (text ?? '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid !== undefined) out.set(pid, line.slice(1));
    }
  }
  return out;
}

export function childrenOf(table: Map<number, Proc>): Map<number, Proc[]> {
  const kids = new Map<number, Proc[]>();
  for (const p of table.values()) {
    if (p.ppid === p.pid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  return kids;
}

/** Every process below `root`. */
export function descendants(kids: Map<number, Proc[]>, root: number): Proc[] {
  const out: Proc[] = [];
  const seen = new Set<number>([root]);
  const stack = [...(kids.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    stack.push(...(kids.get(p.pid) ?? []));
  }
  return out;
}

/** Whether `ancestor` is `pid` or one of its parents. */
export function isAncestor(table: Map<number, Proc>, ancestor: number, pid: number): boolean {
  let cur: number | undefined = pid;
  for (let i = 0; cur !== undefined && i < 64; i += 1) {
    if (cur === ancestor) return true;
    const p = table.get(cur);
    if (!p || p.ppid === cur) return false;
    cur = p.ppid;
  }
  return false;
}
