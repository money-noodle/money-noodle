import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';

interface ForecastWriterOwner {
  pid: number;
  nonce: string;
  createdAt: string;
}

export interface ForecastWriterLease {
  owner: ForecastWriterOwner;
  lockDirectory: string;
  release(): Promise<void>;
}

interface WriterRuntime {
  queue: Promise<void>;
  lease?: ForecastWriterLease;
  leasePromise?: Promise<ForecastWriterLease>;
  exitHookInstalled?: boolean;
}

const runtimeKey = Symbol.for('money-noodle.forecast-writer');
const root = globalThis as typeof globalThis & { [runtimeKey]?: WriterRuntime };
const runtime = (): WriterRuntime => (root[runtimeKey] ??= { queue: Promise.resolve() });
const DATA_DIR = path.resolve(process.cwd(), 'data');
const LOCK_NAME = 'forecast-history.write.lock';

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readOwner(lockDirectory: string): Promise<ForecastWriterOwner | undefined> {
  try { return JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8')) as ForecastWriterOwner; }
  catch { return undefined; }
}

/**
 * Acquires a process-lifetime filesystem lease. A live owner is never displaced. A dead owner's lock is
 * quarantined instead of deleted, leaving an auditable explanation for why another process took over.
 */
export async function acquireForecastWriterLeaseAt(
  dataDirectory: string,
  options: { pid?: number; nonce?: string; now?: () => Date; isProcessAlive?: (pid: number) => boolean } = {},
): Promise<ForecastWriterLease> {
  const pid = options.pid ?? process.pid;
  const nonce = options.nonce ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  const lockDirectory = path.join(dataDirectory, LOCK_NAME);
  await mkdir(dataDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory);
      const owner: ForecastWriterOwner = { pid, nonce, createdAt: now().toISOString() };
      await writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify(owner)}\n`);
      return {
        owner,
        lockDirectory,
        async release() {
          const current = await readOwner(lockDirectory);
          if (current?.nonce !== nonce || current.pid !== pid) return;
          await rm(lockDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readOwner(lockDirectory);
      if (!existing || isProcessAlive(existing.pid)) {
        const identity = existing ? `pid ${existing.pid} since ${existing.createdAt}` : 'an unreadable owner';
        throw new Error(`Forecast mutation refused: writer lease is held by ${identity}.`);
      }
      const quarantined = `${lockDirectory}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
      await rename(lockDirectory, quarantined);
    }
  }
  throw new Error('Forecast mutation refused: unable to acquire the writer lease after stale-lock quarantine.');
}

async function ensureForecastWriterLease(): Promise<ForecastWriterLease> {
  const state = runtime();
  if (state.lease) return state.lease;
  state.leasePromise ??= acquireForecastWriterLeaseAt(DATA_DIR)
    .then((lease) => {
      state.lease = lease;
      if (!state.exitHookInstalled) {
        state.exitHookInstalled = true;
        process.once('exit', () => {
          const held = runtime().lease;
          if (held) rmSync(held.lockDirectory, { recursive: true, force: true });
        });
      }
      return lease;
    })
    .catch((error) => { state.leasePromise = undefined; throw error; });
  return state.leasePromise;
}

/** One queue across all bundled copies in this JavaScript realm, guarded by the process-lifetime lease. */
export function serializeForecastMutation<T>(operation: () => Promise<T>): Promise<T> {
  const state = runtime();
  const running = state.queue.then(async () => {
    await ensureForecastWriterLease();
    return operation();
  });
  state.queue = running.then(() => undefined, () => undefined);
  return running;
}

/** Repair scripts release explicitly; the long-running collector otherwise holds ownership until exit. */
export async function releaseForecastWriterLeaseForShutdown(): Promise<void> {
  const state = runtime();
  await state.queue;
  await state.lease?.release();
  state.lease = undefined;
  state.leasePromise = undefined;
}
