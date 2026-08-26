import 'server-only';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { archiveIntervalMs, archiveStartupDelayMs, localArchiveConfig, readLocalArchiveState } from './local-data-archive';

const runtimeKey = Symbol.for('money-noodle.local-archive-scheduler');
interface ArchiveSchedulerRuntime { started: boolean; running: boolean; timer?: ReturnType<typeof setTimeout> }

function runtime(): ArchiveSchedulerRuntime {
  const root = globalThis as typeof globalThis & { [runtimeKey]?: ArchiveSchedulerRuntime };
  root[runtimeKey] ??= { started: false, running: false };
  return root[runtimeKey];
}

async function due(): Promise<boolean> {
  const config = localArchiveConfig();
  if (!config) return false;
  const state = await readLocalArchiveState(config.dataDirectory).catch(() => undefined);
  if (!state?.lastSuccessAt) return true;
  const last = Date.parse(state.lastSuccessAt);
  return !Number.isFinite(last) || Date.now() - last >= archiveIntervalMs();
}

function schedule(delayMs: number): void {
  const state = runtime();
  state.timer = setTimeout(() => void runIfDue(), delayMs);
  state.timer.unref?.();
}

async function runIfDue(): Promise<void> {
  const state = runtime();
  if (state.running) return;
  if (!(await due())) {
    schedule(Math.min(archiveIntervalMs(), 60 * 60_000));
    return;
  }
  state.running = true;
  const runner = path.resolve(process.cwd(), 'node_modules/.bin/jiti');
  const script = path.resolve(process.cwd(), 'scripts/archive-local-data.ts');
  const child = process.platform === 'win32'
    ? spawn(runner, [script], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit'] })
    : spawn('nice', ['-n', '10', runner, script], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  let settled = false;
  const complete = (successful: boolean, detail?: string) => {
    if (settled) return;
    settled = true;
    state.running = false;
    if (!successful) console.error(`Local archive worker failed${detail ? ` (${detail})` : ''}.`);
    schedule(successful ? Math.min(archiveIntervalMs(), 60 * 60_000) : 60 * 60_000);
  };
  child.once('error', (error) => complete(false, error.message));
  child.once('exit', (code, signal) => complete(code === 0, signal ?? `exit ${code}`));
}

/** Starts only on the persistent local worker; Vercel and disabled configurations are no-ops. */
export function startLocalArchiveScheduler(): void {
  const state = runtime();
  if (state.started || !localArchiveConfig()) return;
  state.started = true;
  schedule(archiveStartupDelayMs());
}
