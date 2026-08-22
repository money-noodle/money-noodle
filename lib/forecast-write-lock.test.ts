import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { acquireForecastWriterLeaseAt } from './forecast-write-lock';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function temporaryRoot() { const root = await mkdtemp(path.join(os.tmpdir(), 'money-forecast-lock-')); roots.push(root); return root; }

describe('forecast writer lease', () => {
  it('refuses a second live owner and permits it only after release', async () => {
    const root = await temporaryRoot();
    const first = await acquireForecastWriterLeaseAt(root, { pid: 101, nonce: 'first', isProcessAlive: () => true });
    await expect(acquireForecastWriterLeaseAt(root, { pid: 202, nonce: 'second', isProcessAlive: () => true }))
      .rejects.toThrow('writer lease is held by pid 101');
    await first.release();
    const second = await acquireForecastWriterLeaseAt(root, { pid: 202, nonce: 'second', isProcessAlive: () => true });
    await second.release();
  });

  it('quarantines a dead owner before acquiring instead of deleting its evidence', async () => {
    const root = await temporaryRoot();
    await acquireForecastWriterLeaseAt(root, {
      pid: 101, nonce: 'dead', now: () => new Date('2026-08-22T01:00:00Z'), isProcessAlive: () => true,
    });
    const replacement = await acquireForecastWriterLeaseAt(root, {
      pid: 202, nonce: 'replacement', now: () => new Date('2026-08-22T02:00:00Z'), isProcessAlive: () => false,
    });
    expect((await readdir(root)).some((file) => file.startsWith('forecast-history.write.lock.corrupt-2026-08-22T02-00-00'))).toBe(true);
    await replacement.release();
  });
});
