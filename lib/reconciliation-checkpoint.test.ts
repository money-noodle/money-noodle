import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  KALSHI_RECONCILIATION_CHECKPOINT_VERSION,
  readKalshiReconciliationCheckpoint,
  writeKalshiReconciliationCheckpoint,
} from './reconciliation-checkpoint';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-reconciliation-'));
  directories.push(value);
  return value;
}

describe('Kalshi reconciliation checkpoint', () => {
  it('treats an absent checkpoint as requiring a full audit', async () => {
    expect(await readKalshiReconciliationCheckpoint(await directory())).toBeUndefined();
  });

  it('atomically round-trips a validated closed interval', async () => {
    const root = await directory();
    const checkpoint = {
      version: KALSHI_RECONCILIATION_CHECKPOINT_VERSION,
      completedThroughTs: 1_767_225_600,
      completedAt: '2026-01-01T00:00:01.000Z',
      trigger: 'periodic' as const,
    };
    await writeKalshiReconciliationCheckpoint(checkpoint, root);
    expect(await readKalshiReconciliationCheckpoint(root)).toEqual(checkpoint);
    expect(JSON.parse(await readFile(path.join(root, 'kalshi-reconciliation-checkpoint.json'), 'utf8'))).toEqual(checkpoint);
  });

  it('fails closed on malformed state instead of resetting the discovery watermark', async () => {
    const root = await directory();
    await writeFile(path.join(root, 'kalshi-reconciliation-checkpoint.json'), JSON.stringify({
      version: KALSHI_RECONCILIATION_CHECKPOINT_VERSION,
      completedThroughTs: 0,
      completedAt: 'not-a-date',
      trigger: 'periodic',
    }));
    await expect(readKalshiReconciliationCheckpoint(root)).rejects.toThrow(/malformed/i);
  });
});
