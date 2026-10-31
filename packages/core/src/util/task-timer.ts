import type { AgentSession, TaskItem } from '../model.ts';

const keyOf = (t: TaskItem) => t.title.trim().toLowerCase() || `#${t.id}`;

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Follows a plan over time: when each task started, how long finished tasks took,
 * and how many actions the agent took on the current one. That is enough for a
 * per-step progress bar ("4m of ~6m typical") without the agent reporting anything extra.
 */
export class TaskTimer {
  private readonly status = new Map<string, string>();
  private readonly started = new Map<string, number>();
  private readonly durations: number[] = [];
  private currentKey: string | undefined;
  private steps = 0;
  private readonly fileStarted = new Map<string, number>();
  private fileDurations: number[] = [];

  /** Feed the full task list whenever it changes, with the time of the change. */
  observe(tasks: readonly TaskItem[], at: number): void {
    for (const t of tasks) {
      const key = keyOf(t);
      const prev = this.status.get(key);
      if (t.status === prev) continue;
      if (t.status === 'in_progress') this.started.set(key, at);
      else if (t.status === 'completed' && prev === 'in_progress') {
        const s = this.started.get(key);
        if (s !== undefined && at >= s) this.durations.push(at - s);
      }
      this.status.set(key, t.status);
    }
    const cur = tasks.find((t) => t.status === 'in_progress');
    const key = cur ? keyOf(cur) : undefined;
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.steps = 0;
      if (key && !this.started.has(key)) this.started.set(key, at);
    }
  }

  /**
   * A second source for agents that keep one file per task (Claude Code's Tasks): a file's
   * mtime is when its status last changed. It covers what the transcript cannot show, such
   * as a conversation that was compacted or resumed after the plan was made. The task in
   * progress started at its file's mtime, and a finished task took about the time since
   * the completion before it; completions less than 10 s apart are batch updates and are skipped.
   */
  observeFiles(tasks: readonly { task: TaskItem; mtimeMs: number }[]): void {
    this.fileStarted.clear();
    for (const { task, mtimeMs } of tasks) if (task.status === 'in_progress') this.fileStarted.set(keyOf(task), mtimeMs);
    const done = tasks.filter((t) => t.task.status === 'completed').map((t) => t.mtimeMs).sort((a, b) => a - b);
    this.fileDurations = [];
    for (let i = 1; i < done.length; i += 1) if (done[i] - done[i - 1] >= 10_000) this.fileDurations.push(done[i] - done[i - 1]);
  }

  /** Count one agent action (tool call) toward the current task. */
  step(): void {
    if (this.currentKey) this.steps += 1;
  }

  current(tasks: readonly TaskItem[]): AgentSession['current'] {
    const cur = tasks.find((t) => t.status === 'in_progress');
    if (!cur) return undefined;
    // The earlier start wins: the transcript may only have seen the plan after the step began.
    const starts = [this.started.get(keyOf(cur)), this.fileStarted.get(keyOf(cur))].filter((x): x is number => x !== undefined);
    if (!starts.length) return undefined;
    const durations = this.durations.length >= this.fileDurations.length ? this.durations : this.fileDurations;
    return { taskId: cur.id, startedAt: Math.min(...starts), steps: keyOf(cur) === this.currentKey ? this.steps : 0, typicalMs: median(durations) };
  }
}
